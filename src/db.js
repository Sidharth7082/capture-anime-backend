// Shared PostgreSQL connection pool for the importer.
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

let pool;

/**
 * Returns a singleton pg.Pool configured from DATABASE_URL.
 * Set PGPOOLMAX (default 10) to control connection concurrency.
 */
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set (see .env.example)');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOLMAX) || 10,
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
