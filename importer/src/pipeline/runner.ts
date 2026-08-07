/**
 * Generic pipeline runner — shared by every import source.
 *
 *   fetchPage -> normalize -> validate -> upsert -> (page done) -> sink
 *
 * Handles: sequential pagination, resume from the last completed page,
 * per-page progress persistence, per-item failure isolation, optional
 * limit/maxPages/dry-run, cancellation between pages, per-source advisory
 * locking (no two runs of the same source can overlap) and job bookkeeping.
 * The Typesense sink is invoked once per completed page.
 *
 * Resume safety: the resume point is only advanced for FULLY processed
 * pages. A cancelled page, or a page whose sink failed, is never marked
 * complete — the next run replays it (upserts are idempotent), so no items
 * and no search-index updates are ever skipped.
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
  const dryRun = options.dryRun ?? false;

  // Serialize concurrent runs of the same source (daemon + manual CLI).
  // The advisory lock is session-scoped, so it is held on one dedicated
  // pooled connection for the whole run and always released in finally.
  let release: (() => Promise<void>) | null = null;
  if (!dryRun) {
    release = await deps.jobs.acquireRunLock(deps.source);
  }
  try {
    return await runLocked(deps, options, dryRun);
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        deps.logger?.error?.(`[${deps.source}] failed to release run lock: ${String(err)}`);
      }
    }
  }
}

async function runLocked<T, R>(
  deps: ConcreteDeps<T, R>,
  options: PipelineOptions,
  dryRun: boolean,
): Promise<RunResult> {
  const { source, fetcher, normalizer, validator, upsert, jobs, sink } = deps;
  const logger = deps.logger ?? console;
  const isCancelled = deps.isCancelled ?? (() => false);

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
  let sinkFailedPage: number | null = null;

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
        const outcome = await upsert.upsert(check.row);
        if (outcome === "inserted") counts.inserted += 1;
        else counts.updated += 1;
        pageRows.push(check.row); // only rows that persisted reach the sink
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

    // Enforce the item limit at PAGE boundaries only: every page is processed
    // atomically, so a truncated page can never become the resume point.
    if (options.limit != null && counts.fetched >= options.limit) limitReached = true;

    if (!dryRun && !cancelled) {
      // Sink first, then advance the resume point. If indexing fails, the
      // page is replayed on the next run (DB writes are idempotent) instead
      // of leaving a permanent gap in the search index.
      try {
        await sink.ingest(pageRows);
        await jobs.markPage(source, page, counts.fetched);
      } catch (err) {
        sinkFailedPage = page;
        logger.error(`[${source}] sink failed on page ${page} — page will be retried on the next run: ${String(err)}`, { source, page });
      }
    }

    if (limitReached || cancelled || !pageResult.hasNextPage) break;
    page += 1;
    if (deps.pageDelayMs) await delay(deps.pageDelayMs);
  }

  const finalStatus = cancelled || sinkFailedPage != null ? ("failed" as const) : ("completed" as const);
  const error = cancelled
    ? "cancelled by signal"
    : sinkFailedPage != null
      ? `sink failed on page ${sinkFailedPage} (page will be retried)`
      : null;
  if (!dryRun) await jobs.markFinished(source, finalStatus, error);

  const summary = `${source}: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.failed} failed, ${counts.fetched} fetched (${limitReached ? "limit" : cancelled ? "cancelled" : sinkFailedPage != null ? "sink failed" : "complete"}${dryRun ? ", dry-run" : ""})`;
  return { ok: counts.failed === 0 && !cancelled && sinkFailedPage == null, ...counts, summary };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
