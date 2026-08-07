// Shared PostgreSQL connection pool for the importer (and the API).
import 'dotenv/config';
import pg from 'pg';
import { logger } from './lib/logger.js';

const { Pool } = pg;

let pool;

const SLOW_QUERY_MS = Number(process.env.PG_SLOW_QUERY_MS) || 250;

/**
 * Returns a singleton pg.Pool configured from DATABASE_URL.
 * Set PGPOOLMAX (default 10) to control connection concurrency.
 *
 * Production hardening:
 * - statement_timeout kills runaway queries (default 15s) so one bad query
 *   cannot hold a pool connection forever.
 * - every query is timed; queries slower than PG_SLOW_QUERY_MS (default
 *   250ms) are logged with their (truncated) text, so slow queries surface
 *   in the logs without an APM agent.
 */
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set (see .env.example)');
    }
    const statementTimeoutMs = Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 15_000;
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOLMAX) || 10,
      // `options` is passed to the server as postgres startup options.
      options: `-c statement_timeout=${statementTimeoutMs}`,
    });

    const originalQuery = pool.query.bind(pool);
    pool.query = (async (text, params) => {
      const started = performance.now();
      try {
        return await originalQuery(text, params);
      } finally {
        const elapsed = performance.now() - started;
        if (elapsed > SLOW_QUERY_MS) {
          const sql = typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 300) : String(text);
          logger.warn(`[db] slow query ${elapsed.toFixed(0)}ms: ${sql}`);
        }
      }
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
