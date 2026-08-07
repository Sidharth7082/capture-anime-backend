/**
 * PostgreSQL access for the importer.
 *
 * Thin wrapper around `pg`'s Pool: connection lifecycle, typed query helper
 * and a health ping. No schema lives here — table DDL stays in the API's
 * migrations (this project must not drift the schema on its own).
 */
import pg from "pg";

const { Pool } = pg;

export interface DatabaseConfig {
  connectionString: string;
  max?: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export class Database {
  private readonly pool: pg.Pool;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;

  constructor(config: DatabaseConfig) {
    this.logger = config.logger ?? console;
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
      // idletimeoutMillis default (10s) is fine for a periodic importer.
    });

    // Surface pool errors instead of crashing the process silently.
    this.pool.on("error", (err) => {
      this.logger.error(`[db] idle client error: ${err.message}`);
    });
  }

  /** Run a parameterized query. */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /**
   * Run `fn` inside a transaction (BEGIN/COMMIT/ROLLBACK). The client is
   * always released, even on error. Used by the importer for per-row
   * atomic upserts.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // connection may already be broken — nothing else to clean up
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /** Simple `SELECT 1` health check. */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Session-scoped Postgres advisory lock (hashtextextended, PG 11+).
   * Checks out ONE dedicated pooled connection, locks it, and returns a
   * release function that unlocks AND returns the connection to the pool.
   * The caller must always invoke the release function (try/finally).
   */
  async advisoryLock(key: string): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
    } catch (err) {
      client.release();
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } finally {
        client.release();
      }
    };
  }

  /** Release all pooled connections (call on shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(config: DatabaseConfig): Database {
  return new Database(config);
}
