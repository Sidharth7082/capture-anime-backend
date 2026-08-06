// Shared PostgreSQL connection pool.
import pg from 'pg';
import { env } from '../config/env.js';

// Our identity ids (BIGINT) stay well below Number.MAX_SAFE_INTEGER, so
// returning them as JS numbers keeps API payloads clean (no string ids).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => parseInt(value, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/** Runs `fn` inside a transaction, rolling back on error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
