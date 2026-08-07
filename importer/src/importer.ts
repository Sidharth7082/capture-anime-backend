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
import type { Metrics } from "./metrics.js";
import { createJikanAnimeFetcher } from "./pipeline/fetchers.js";
import { normalizeAnimeItem, type JikanAnime } from "./pipeline/normalizers.js";
import { validateAnimeRow } from "./pipeline/validator.js";
import { createAnimeUpsertService } from "./pipeline/upsert-service.js";
import { createPostgresJobStore } from "./pipeline/job-store.js";
import { runPipeline } from "./pipeline/runner.js";
import type { JobStore, NormalizedAnime, RunResult, Sink } from "./pipeline/types.js";

export interface ImportDeps {
  jikan: JikanClient;
  db: Database;
  typesense: TypesenseClient;
  /** Optional metrics registry for the /health endpoint. */
  metrics?: Metrics;
  /** Polite delay between page requests (0 to disable). */
  pageDelayMs?: number;
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
   * Scheduled entrypoint (called by the scheduler). Runs the anime import;
   * later stages compose additional sources on top.
   */
  async run(): Promise<RunResult> {
    return this.importAnime();
  }
}

export function createImporter(deps: ImportDeps): Importer {
  return new Importer(deps);
}
