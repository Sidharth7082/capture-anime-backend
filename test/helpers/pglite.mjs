// Shared PGlite (WASM Postgres) harness for DB-backed tests: applies every
// db/migrations/*.up.sql the same way test/migrations.smoke.test.mjs does,
// so repository tests run against the real schema.
import { PGlite } from '@electric-sql/pglite';
import * as pgTrgmContrib from '@electric-sql/pglite/contrib/pg_trgm';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

const EXTENSION_RE = /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+);/gim;
const TRGM_INDEX_STATEMENT_RE = /^CREATE\s+INDEX[^;]*gin_trgm_ops[^;]*;/gim;

async function applyFile(db, file) {
  let sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  const failed = new Set();
  for (const [, name] of sql.matchAll(EXTENSION_RE)) {
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS ${name}`);
    } catch {
      failed.add(name);
    }
  }
  sql = sql.replace(EXTENSION_RE, (whole, name) => (failed.has(name) ? '' : whole));
  if (failed.has('pg_trgm') && sql.includes('gin_trgm_ops')) {
    sql = sql.replace(TRGM_INDEX_STATEMENT_RE, '');
  }
  await db.exec(sql);
}

/** A fresh database with all migrations applied (one per call). */
export async function createTestDb() {
  const db = new PGlite({ extensions: { pg_trgm: pgTrgmContrib.pg_trgm } });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.up.sql')).sort();
  for (const file of files) await applyFile(db, file);
  // Repository-shaped adapter: repositories call pool.query(text, params) and
  // occasionally pool.connect() (e.g. mal deleteAccount) for a client.
  return {
    db,
    pool: {
      query: async (text, params = []) => {
        const res = await db.query(text, params);
        // pg-compatible shape: PGlite reports affectedRows, pg reports rowCount.
        return { ...res, rowCount: res.affectedRows ?? res.rows.length };
      },
      connect: () => ({
        query: async (text, params = []) => {
          const res = await db.query(text, params);
          return { ...res, rowCount: res.affectedRows ?? res.rows.length };
        },
        release: () => {},
      }),
    },
  };
}

export async function seedAnime(pool, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anime (anilist_id, id_mal, title_romaji, title_english, title_native,
                        description, format, status, episodes, season, season_year,
                        average_score, popularity, favourites, is_adult, slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      overrides.anilistId ?? 1,
      overrides.idMal ?? 1,
      overrides.titleRomaji ?? 'Cowboy Bebop',
      overrides.titleEnglish ?? 'Cowboy Bebop',
      overrides.titleNative ?? 'カウボーイビバップ',
      overrides.description ?? 'Space jazz.',
      overrides.format ?? 'TV',
      overrides.status ?? 'FINISHED',
      overrides.episodes ?? 26,
      overrides.season ?? 'SPRING',
      overrides.seasonYear ?? 1998,
      overrides.averageScore ?? 86,
      overrides.popularity ?? 500_000,
      overrides.favourites ?? 10_000,
      overrides.isAdult ?? false,
      overrides.slug ?? 'cowboy-bebop',
    ],
  );
  return rows[0].id;
}

export async function seedUser(pool, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [overrides.username ?? 'alice', overrides.email ?? 'alice@example.com', overrides.passwordHash ?? 'hash'],
  );
  return rows[0].id;
}
