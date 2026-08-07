/**
 * Generic pipeline runner — shared by every import source.
 *
 *   fetchPage -> normalize -> validate -> upsert -> (page done) -> sink
 *
 * Handles: sequential pagination, resume from the last completed page,
 * per-page progress persistence, per-item failure isolation, optional
 * limit/maxPages/dry-run, cancellation between pages, and job bookkeeping.
 * The Typesense sink is invoked once per completed page.
 */
import type {
  Fetcher,
  JobStore,
  Normalizer,
  PipelineDeps,
  PipelineOptions,
  RunCounters,
  RunResult,
  Sink,
  UpsertPort,
  Validator,
} from "./types.js";

export interface ConcreteDeps<T, R> {
  source: string;
  fetcher: Fetcher<T>;
  normalizer: Normalizer<T, R>;
  validator: Validator<R>;
  upsert: UpsertPort<R>;
  jobs: JobStore;
  sink: Sink<R>;
  pageDelayMs?: number;
  isCancelled?: () => boolean;
  /** Called after each completed page with live counters (metrics/UI). */
  onProgress?: (page: number, counts: RunCounters) => void;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export async function runPipeline<T, R>(
  deps: ConcreteDeps<T, R>,
  options: PipelineOptions = {},
): Promise<RunResult> {
  const { source, fetcher, normalizer, validator, upsert, jobs, sink } = deps;
  const logger = deps.logger ?? console;
  const isCancelled = deps.isCancelled ?? (() => false);
  const dryRun = options.dryRun ?? false;

  // Resume: continue from the last completed page (unless reset/startPage).
  const resumePage = options.reset ? 0 : await jobs.getResumePage(source);
  const startPage = options.startPage ?? resumePage + 1;
  if (!dryRun) await jobs.markStarted(source, resumePage);
  logger.info(
    `[${source}] started (resume from page ${resumePage}; starting at ${startPage}${dryRun ? ", dry-run" : ""})`,
    { source, resumePage, startPage, dryRun },
  );

  const counts = { fetched: 0, inserted: 0, updated: 0, failed: 0 };
  let page = startPage;
  let limitReached = false;
  let cancelled = false;

  for (;;) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    if (options.maxPages != null && page - startPage >= options.maxPages) break;

    let pageResult;
    try {
      pageResult = await fetcher.fetchPage(page);
    } catch (err) {
      counts.failed += 1;
      logger.error(`[${source}] page ${page} failed after retries: ${String(err)}`, { source, page });
      await jobs.markFinished(source, "failed", String(err));
      return { ok: false, ...counts, summary: `${source}: aborted on page ${page} (${String(err)})` };
    }

    const items = pageResult.items ?? [];
    if (items.length === 0) break;

    const pageRows: R[] = [];
    for (const raw of items) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      if (options.limit != null && counts.fetched >= options.limit) {
        limitReached = true;
        break;
      }
      counts.fetched += 1;

      try {
        const row = normalizer(raw);
        const check = validator(row);
        if (!check.ok) {
          counts.failed += 1;
          logger.warn(`[${source}] invalid row skipped: ${check.reason}`);
          continue;
        }
        if (dryRun) {
          counts.updated += 1; // would-upsert; exact insert/update unknown without DB
          continue;
        }
        pageRows.push(check.row);
        const outcome = await upsert.upsert(check.row);
        if (outcome === "inserted") counts.inserted += 1;
        else counts.updated += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error(`[${source}] item failed: ${String(err)}`);
      }
    }

    logger.info(
      `[${source}] page ${page}: +${counts.inserted} / ~${counts.updated} / !${counts.failed} (${counts.fetched} fetched${dryRun ? " [dry-run]" : ""})`,
      { source, page, inserted: counts.inserted, updated: counts.updated, failed: counts.failed, fetched: counts.fetched, dryRun },
    );
    deps.onProgress?.(page, { ...counts });

    if (!dryRun) {
      // Persist the resume point AFTER the page fully succeeded.
      await jobs.markPage(source, page, counts.fetched);
      // Feed the page's rows to the sink (Typesense) once indexing lands.
      await sink.ingest(pageRows);
    }

    if (limitReached || !pageResult.hasNextPage) break;
    page += 1;
    if (deps.pageDelayMs) await delay(deps.pageDelayMs);
  }

  const finalStatus = cancelled ? ("failed" as const) : ("completed" as const);
  const error = cancelled ? "cancelled by signal" : null;
  if (!dryRun) await jobs.markFinished(source, finalStatus, error);

  const summary = `${source}: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.failed} failed, ${counts.fetched} fetched (${limitReached ? "limit" : cancelled ? "cancelled" : "complete"}${dryRun ? ", dry-run" : ""})`;
  return { ok: counts.failed === 0 && !cancelled, ...counts, summary };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
