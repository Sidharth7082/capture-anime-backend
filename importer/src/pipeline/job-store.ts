/**
 * import_jobs persistence — resume support.
 *
 * One row per source keeps the last completed page so a crashed/cancelled
 * run resumes from last_page + 1 instead of re-fetching the catalogue.
 */
import type { Database } from "../database.js";
import type { JobStore } from "./types.js";

export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Database) {}

  async getResumePage(source: string): Promise<number> {
    const res = await this.db.query<{ last_page: number }>(
      "SELECT last_page FROM import_jobs WHERE source = $1",
      [source],
    );
    return res.rows[0]?.last_page ?? 0;
  }

  async markStarted(source: string, resumePage: number): Promise<void> {
    await this.db.query(
      `INSERT INTO import_jobs (source, status, last_page, started_at, updated_at)
       VALUES ($1, 'running', $2, now(), now())
       ON CONFLICT (source) DO UPDATE
         SET status = 'running',
             last_page = EXCLUDED.last_page,
             error = NULL,
             started_at = CASE WHEN import_jobs.status = 'completed' THEN now() ELSE import_jobs.started_at END,
             updated_at = now()`,
      [source, resumePage],
    );
  }

  async markPage(source: string, page: number, totalItems: number): Promise<void> {
    await this.db.query(
      "UPDATE import_jobs SET last_page = $2, total_items = $3, updated_at = now() WHERE source = $1",
      [source, page, totalItems],
    );
  }

  async markFinished(
    source: string,
    status: "completed" | "failed",
    error?: string | null,
  ): Promise<void> {
    await this.db.query(
      "UPDATE import_jobs SET status = $2, finished_at = now(), error = $3, updated_at = now() WHERE source = $1",
      [source, status, error ?? null],
    );
  }
}

export function createPostgresJobStore(db: Database): PostgresJobStore {
  return new PostgresJobStore(db);
}

/**
 * In-memory job store for --dry-run: reports no resume point and discards
 * writes, so the pipeline contract holds without a database connection.
 */
export function createNoopJobStore(): JobStore {
  return {
    async getResumePage() {
      return 0;
    },
    async markStarted() {},
    async markPage() {},
    async markFinished() {},
  };
}
