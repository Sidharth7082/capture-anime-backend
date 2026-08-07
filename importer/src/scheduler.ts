/**
 * Interval scheduler for periodic import runs.
 *
 * Runs the job on a fixed interval with an overlap guard: if a previous run
 * is still in flight when the next tick fires, that tick is skipped and
 * logged instead of stacking concurrent imports.
 */
export interface SchedulerOptions {
  intervalMs: number;
  runOnStart: boolean;
  /** Called when a run starts/finishes (metrics / next-run tracking). */
  onRunStart?: () => void;
  onRunFinished?: () => void;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface Scheduler {
  /** Begin scheduling. Call exactly once. */
  start(): void;
  /** Stop scheduling and wait for any in-flight run. */
  stop(): Promise<void>;
  /** When the next interval tick fires (null before start). */
  getNextRunAt(): number | null;
}

export function createScheduler(
  job: () => Promise<unknown>,
  options: SchedulerOptions,
): Scheduler {
  const logger = options.logger ?? console;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopping = false;
  let nextRunAt: number | null = null;

  const runOnce = async (trigger: "start" | "interval") => {
    if (running) {
      logger.warn(`[scheduler] ${trigger} tick skipped — previous run still in flight`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      logger.info(`[scheduler] ${trigger} run started`);
      options.onRunStart?.();
      await job();
      logger.info(`[scheduler] ${trigger} run finished in ${Date.now() - startedAt}ms`);
    } catch (err) {
      logger.error(`[scheduler] ${trigger} run failed: ${String(err)}`);
    } finally {
      running = false;
      nextRunAt = Date.now() + options.intervalMs;
      options.onRunFinished?.();
    }
  };

  return {
    start() {
      if (timer) return;
      if (options.runOnStart) {
        // Fire-and-forget the immediate run; scheduling continues regardless.
        void runOnce("start");
      }
      if (options.intervalMs > 0) {
        timer = setInterval(() => void runOnce("interval"), options.intervalMs);
        timer.unref?.();
        nextRunAt = Date.now() + options.intervalMs;
      }
    },

    getNextRunAt() {
      return nextRunAt;
    },

    async stop() {
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Wait for an in-flight run to settle (bounded by a generous timeout).
      const deadline = Date.now() + 60_000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      void stopping;
    },
  };
}
