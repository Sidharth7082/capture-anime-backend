/**
 * Import orchestrator — composition root.
 *
 * STAGE 1 (ANIME): wires the Jikan anime source into the shared pipeline:
 *
 *   JikanAnimeFetcher -> normalizeAnimeItem -> validateAnimeRow
 *        -> AnimeUpsertService (anime table, upsert by mal_id)
 *        -> no-op Typesense sink (Stage 5)
 *
 * Resume support: the runner persists per-page progress in `import_jobs`,
 * so a crash on page 1,247 resumes at 1,248 (pass `reset` to start over).
 *
 * New data sources only add a fetcher + normalizer; the rest is reused.
 */
import type { JikanClient } from "./jikan.js";
import type { Database } from "./database.js";
import type { TypesenseClient } from "./typesense.js";
import { createNoopSink } from "./typesense.js";
import type { Metrics } from "./metrics.js";
import { createJikanAnimeFetcher, createJikanEnrichFetcher } from "./pipeline/fetchers.js";
import { normalizeAnimeItem, normalizeAnimeEnrichment, type JikanAnime, type JikanEnrichmentBundle } from "./pipeline/normalizers.js";
import { validateAnimeRow, validateAnimeEnrichment } from "./pipeline/validator.js";
import { createAnimeUpsertService } from "./pipeline/upsert-service.js";
import { createAnimeEnrichUpsertService } from "./pipeline/enrich-upsert-service.js";
import { createPostgresJobStore } from "./pipeline/job-store.js";
import { runPipeline } from "./pipeline/runner.js";
import type { JobStore, NormalizedAnime, NormalizedAnimeEnrichment, RunResult, Sink } from "./pipeline/types.js";

export interface ImportDeps {
  jikan: JikanClient;
  db: Database;
  typesense: TypesenseClient;
  /** Optional metrics registry for the /health endpoint. */
  metrics?: Metrics;
  /** Polite delay between page requests (0 to disable). */
  pageDelayMs?: number;
  /** Enrichment batch size (anime per page, each = 6 detail requests). */
  enrichBatchSize?: number;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface AnimeImportOptions {
  limit?: number;
  maxPages?: number;
  dryRun?: boolean;
  /** Ignore the saved resume point and start from page 1. */
  reset?: boolean;
}

export class Importer {
  private readonly deps: ImportDeps;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;
  private cancelled = false;
  private jobs: JobStore;
  private readonly sink: Sink<NormalizedAnime>;

  constructor(deps: ImportDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? console;
    this.jobs = createPostgresJobStore(deps.db);
    // Real Typesense sink when enabled, no-op otherwise.
    this.sink = deps.typesense.createSink();
  }

  /** Ask a running import to stop at the next safe boundary (page/item). */
  cancel(): void {
    this.cancelled = true;
  }

  /** Override the job store (used by the CLI for --dry-run). */
  setJobStore(jobs: JobStore): void {
    this.jobs = jobs;
  }

  /**
   * STAGE 1: import the anime catalogue through the pipeline.
   * Sequential pages; per-row transaction; idempotent upsert by mal_id;
   * resumes from the last completed page unless `reset` is set.
   */
  async importAnime(options: AnimeImportOptions = {}): Promise<RunResult> {
    this.cancelled = false;
    const metrics = this.deps.metrics;
    metrics?.recordStart("jikan-anime");
    try {
      const result = await runPipeline<JikanAnime, NormalizedAnime>(
        {
          source: "jikan-anime",
          fetcher: createJikanAnimeFetcher(this.deps.jikan),
          normalizer: normalizeAnimeItem,
          validator: validateAnimeRow,
          upsert: createAnimeUpsertService(this.deps.db),
          jobs: this.jobs,
          sink: this.sink,
          pageDelayMs: this.deps.pageDelayMs,
          isCancelled: () => this.cancelled,
          onProgress: (page, counts) => metrics?.recordPage("jikan-anime", page, counts),
          logger: this.logger,
        },
        options,
      );
      metrics?.recordEnd("jikan-anime", result, result.ok ? "completed" : "failed");
      return result;
    } catch (err) {
      metrics?.recordEnd("jikan-anime", {
        ok: false,
        fetched: 0,
        inserted: 0,
        updated: 0,
        failed: 0,
        summary: String(err),
      }, "failed", String(err));
      throw err;
    }
  }

  /**
   * STAGE 4: enrich the catalog's content relationships. Iterates the anime
   * already in the DB, fetching characters / voice actors / staff / relations /
   * recommendations / pictures / videos per anime. Same pipeline, its own
   * `jikan-enrich` resume point. Idempotent (replace-per-anime).
   */
  async enrichAnime(options: AnimeImportOptions = {}): Promise<RunResult> {
    this.cancelled = false;
    const metrics = this.deps.metrics;
    if (!this.deps.db) {
      // CLI --dry-run: no database to enumerate; report a clean empty run.
      const empty: RunResult = { ok: true, fetched: 0, inserted: 0, updated: 0, failed: 0, summary: "jikan-enrich: no database (dry-run)" };
      return empty;
    }
    metrics?.recordStart("jikan-enrich");
    const batchSize = this.deps.enrichBatchSize ?? 10;
    try {
      const result = await runPipeline<JikanEnrichmentBundle, NormalizedAnimeEnrichment>(
        {
          source: "jikan-enrich",
          fetcher: createJikanEnrichFetcher({
            jikan: this.deps.jikan,
            listAnime: async () => {
              const rows = await this.deps.db.query<{ id: number; id_mal: number }>(
                "SELECT id, id_mal FROM anime ORDER BY id_mal",
              );
              return rows.rows.map((r) => ({ id: r.id, idMal: r.id_mal }));
            },
            batchSize,
            logger: this.logger,
          }),
          normalizer: normalizeAnimeEnrichment,
          validator: validateAnimeEnrichment,
          upsert: createAnimeEnrichUpsertService(this.deps.db),
          jobs: this.jobs,
          sink: createNoopSink(this.logger as Pick<Console, "debug" | "info" | "warn" | "error">) as Sink<NormalizedAnimeEnrichment>,
          pageDelayMs: this.deps.pageDelayMs,
          isCancelled: () => this.cancelled,
          onProgress: (page, counts) => metrics?.recordPage("jikan-enrich", page, counts),
          logger: this.logger,
        },
        options,
      );
      metrics?.recordEnd("jikan-enrich", result, result.ok ? "completed" : "failed");
      return result;
    } catch (err) {
      metrics?.recordEnd("jikan-enrich", {
        ok: false,
        fetched: 0,
        inserted: 0,
        updated: 0,
        failed: 0,
        summary: String(err),
      }, "failed", String(err));
      throw err;
    }
  }

  /**
   * Scheduled entrypoint (called by the scheduler). Runs the anime import,
   * then enriches the (possibly updated) catalog.
   */
  async run(): Promise<RunResult[]> {
    const results: RunResult[] = [];
    results.push(await this.importAnime());
    results.push(await this.enrichAnime());
    return results;
  }
}

export function createImporter(deps: ImportDeps): Importer {
  return new Importer(deps);
}
