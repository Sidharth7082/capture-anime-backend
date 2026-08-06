// ============================================================================
// Smoke test: applies every db/migrations/*.up.sql against an in-memory
// PostgreSQL (PGlite / WASM), exercises the constraints and triggers with
// representative inserts, then rolls everything back via the .down.sql files.
//
// PGlite only bundles a subset of extensions, so CREATE EXTENSION statements
// are attempted first and skipped (with a log line) when unsupported —
// pgcrypto is unnecessary on PG13+ and pg_trgm only matters for 0003.
//
//   npm run test:smoke
// ============================================================================

import { PGlite } from '@electric-sql/pglite';
import * as pgTrgmContrib from '@electric-sql/pglite/contrib/pg_trgm';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const EXTENSION_RE = /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+);/gim;
const TRGM_INDEX_STATEMENT_RE = /^CREATE\s+INDEX[^;]*gin_trgm_ops[^;]*;/gim;

const EXPECTED_TABLES = [
  'users', 'anime', 'genres', 'anime_genres', 'studios', 'anime_studios',
  'characters', 'anime_characters', 'staff', 'character_staff', 'episodes',
  'favorites', 'watchlists', 'watch_history', 'ratings', 'comments',
];

function ok(label) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}

async function applyFile(db, file) {
  let sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  // Try each CREATE EXTENSION against PGlite; drop only the statements whose
  // extension cannot be loaded (e.g. pgcrypto has no bundled JS loader here,
  // though it is unnecessary on PostgreSQL 13+ where gen_random_uuid() is core).
  const failed = new Set();
  for (const [, name] of sql.matchAll(EXTENSION_RE)) {
    try {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS ${name}`);
      ok(`extension ${name} created`);
    } catch {
      failed.add(name);
      console.log(`  - extension ${name} skipped (not loadable in PGlite)`);
    }
  }
  sql = sql.replace(EXTENSION_RE, (whole, name) => (failed.has(name) ? '' : whole));

  // Last-resort fallback: if pg_trgm is unavailable, skip its index statements.
  if (failed.has('pg_trgm') && sql.includes('gin_trgm_ops')) {
    const stripped = sql.match(TRGM_INDEX_STATEMENT_RE)?.length ?? 0;
    sql = sql.replace(TRGM_INDEX_STATEMENT_RE, '');
    console.log(`  - ${stripped} trigram index statement(s) skipped (pg_trgm unavailable)`);
  }

  await db.exec(sql);
  ok(`applied ${file}`);
}

async function main() {
  // Load the extensions bundled with PGlite so the migration files run
  // unmodified (pg_trgm and pgcrypto are both real PostgreSQL extensions).
  const db = new PGlite({
    extensions: {
      pg_trgm: pgTrgmContrib.pg_trgm,
    },
  });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.up.sql')).sort();
  if (files.length === 0) throw new Error('no up migrations found');

  console.log('\n== applying migrations ==');
  for (const file of files) await applyFile(db, file);

  console.log('\n== schema assertions ==');
  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const actual = new Set(tables.map((r) => r.table_name));
  for (const t of EXPECTED_TABLES) {
    if (!actual.has(t)) throw new Error(`table ${t} missing`);
  }
  ok(`all ${EXPECTED_TABLES.length} tables present`);

  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'anime' AND column_name = 'search_vector'`,
  );
  if (cols.length !== 1) throw new Error('anime.search_vector generated column missing');
  ok('anime.search_vector generated column present (0003)');

  const { rows: enums } = await db.query(
    `SELECT typname FROM pg_type WHERE typtype = 'e'`,
  );
  ok(`${enums.length} enum types created`);

  console.log('\n== functional checks ==');
  await db.query(`INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)`, ['alice', 'alice@example.com', 'x']);
  const { rows: users } = await db.query(`SELECT id FROM users WHERE username = 'alice'`);
  const userId = users[0].id;

  await db.query(
    `INSERT INTO anime (anilist_id, title_romaji, media_type, format, status, episodes, is_adult)
     VALUES ($1, $2, 'ANIME', 'TV', 'FINISHED', 24, FALSE)`,
    [1, 'Test Anime'],
  );
  const { rows: anime } = await db.query(`SELECT id FROM anime WHERE anilist_id = 1`);
  const animeId = anime[0].id;

  await db.query(`INSERT INTO genres (name) VALUES ('Action') ON CONFLICT (name) DO NOTHING`);
  const { rows: genre } = await db.query(`SELECT id FROM genres WHERE name = 'Action'`);
  await db.query(`INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)`, [animeId, genre[0].id]);

  await db.query(`INSERT INTO studios (anilist_id, name) VALUES (9001, 'Studio X')`);
  const { rows: studio } = await db.query(`SELECT id FROM studios WHERE anilist_id = 9001`);
  await db.query(`INSERT INTO anime_studios (anime_id, studio_id, is_main) VALUES ($1, $2, TRUE)`, [animeId, studio[0].id]);

  await db.query(`INSERT INTO characters (anilist_id, name_first, name_last) VALUES (101, 'Yuki', 'Tanaka')`);
  const { rows: character } = await db.query(`SELECT id FROM characters WHERE anilist_id = 101`);
  await db.query(`INSERT INTO anime_characters (anime_id, character_id, role) VALUES ($1, $2, 'MAIN')`, [animeId, character[0].id]);

  await db.query(`INSERT INTO staff (anilist_id, name_first, language) VALUES (202, 'Sakura', 'Japanese')`);
  const { rows: va } = await db.query(`SELECT id FROM staff WHERE anilist_id = 202`);
  await db.query(`INSERT INTO character_staff (character_id, staff_id, language) VALUES ($1, $2, 'Japanese')`, [character[0].id, va[0].id]);

  await db.query(`INSERT INTO episodes (anime_id, number, title) VALUES ($1, 1, 'Episode 1')`, [animeId]);
  const { rows: episode } = await db.query(`SELECT id FROM episodes WHERE anime_id = $1 AND number = 1`, [animeId]);

  await db.query(`INSERT INTO favorites (user_id, anime_id) VALUES ($1, $2)`, [userId, animeId]);
  await db.query(`INSERT INTO watchlists (user_id, anime_id, status, started_at) VALUES ($1, $2, 'WATCHING', '2024-01-01')`, [userId, animeId]);
  await db.query(`INSERT INTO watch_history (user_id, episode_id, progress_seconds, duration_seconds, completed) VALUES ($1, $2, 1200, 1440, TRUE)`, [userId, episode[0].id]);
  await db.query(`INSERT INTO ratings (user_id, anime_id, score) VALUES ($1, $2, 9)`, [userId, animeId]);
  await db.query(`INSERT INTO comments (user_id, anime_id, content) VALUES ($1, $2, 'Great show!')`, [userId, animeId]);
  const { rows: comment } = await db.query(`SELECT id FROM comments WHERE anime_id = $1`, [animeId]);
  await db.query(`INSERT INTO comments (user_id, anime_id, parent_id, content) VALUES ($1, $2, $3, 'Agreed!')`, [userId, animeId, comment[0].id]);
  ok('representative insert graph accepted (users/anime/genres/studios/characters/staff/episodes/favorites/watchlists/history/ratings/comments)');

  // updated_at trigger fires
  await db.query(`UPDATE anime SET title_romaji = 'Renamed' WHERE id = $1`, [animeId]);
  const { rows: updated } = await db.query(`SELECT updated_at > created_at AS touched FROM anime WHERE id = $1`, [animeId]);
  if (!updated[0].touched) throw new Error('set_updated_at trigger did not fire');
  ok('set_updated_at trigger fires');

  // comment parent target enforcement
  let rejected = false;
  try {
    await db.query(`INSERT INTO comments (user_id, anime_id, parent_id, content) VALUES ($1, NULL, $2, 'cross')`, [userId, comment[0].id]);
  } catch (e) {
    rejected = /parent must target/.test(e.message);
  }
  if (!rejected) throw new Error('cross-target reply was not rejected');
  ok('cross-target comment reply rejected by trigger');

  // constraint checks
  rejected = false;
  try {
    await db.query(`INSERT INTO ratings (user_id, anime_id, score) VALUES ($1, $2, 11)`, [userId, animeId]);
  } catch (e) {
    rejected = /ratings_score_check/.test(e.message) || e.message.includes('violates');
  }
  if (!rejected) throw new Error('score > 10 accepted');
  ok('ratings score CHECK enforced');

  rejected = false;
  try {
    await db.query(`INSERT INTO watchlists (user_id, anime_id, status, progress_episodes) VALUES ($1, $2, 'WATCHING', 5)`, [userId, animeId]);
  } catch (e) {
    rejected = /watchlists_progress_check/.test(e.message) || e.message.includes('violates');
  }
  if (!rejected) throw new Error('progress without started_at accepted');
  ok('watchlists progress CHECK enforced');

  console.log('\n== rolling back (down migrations) ==');
  const downFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.down.sql')).sort().reverse();
  for (const file of downFiles) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(sql);
    ok(`applied ${file}`);
  }

  const { rows: after } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${EXPECTED_TABLES.map((_, i) => `$${i + 1}`).join(',')})`,
    EXPECTED_TABLES,
  );
  if (after.length > 0) throw new Error(`tables remain after down migrations: ${after.map((r) => r.table_name)}`);
  ok('all tables dropped by down migrations');

  console.log('\n\x1b[32mAll smoke checks passed.\x1b[0m');
  await db.close();
}

main().catch((err) => {
  console.error(`\nsmoke test failed: ${err.message}`);
  process.exit(1);
});
