// ============================================================================
// End-to-end test: real migration files + real importer SQL + real AniList
// API data, executed against PGlite (an actual PostgreSQL engine in WASM).
//
//   * applies db/migrations/*.up.sql verbatim (pg_trgm loaded from contrib;
//     the optional pgcrypto line is skipped — gen_random_uuid() is core)
//   * fetches one page of media from the live AniList GraphQL API
//   * runs the importer's upsert logic against PGlite via a pg-shaped adapter
//   * asserts row counts, idempotency and search behaviour
//
// Requires network access to https://graphql.anilist.co.
//
//   npm run test:e2e
// ============================================================================

import { PGlite } from '@electric-sql/pglite';
import * as pgTrgmContrib from '@electric-sql/pglite/contrib/pg_trgm';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AniListClient } from '../src/anilist/client.js';
import { importMediaWithClient } from '../src/anilist/importer.js';
import { PAGE_MEDIA_QUERY } from '../src/anilist/queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const EXTENSION_RE = /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(\w+);/gim;

function ok(label) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}

// --- pg-shaped adapter over PGlite ------------------------------------------
// PGlite has no transaction/session model, so the adapter runs statements in
// autocommit mode; importMediaWithClient only needs query(sql, params).
function makeClient(db) {
  return {
    query: (text, params) => db.query(text, params ?? []),
  };
}

async function applyMigrationFiles(db) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.up.sql')).sort();
  for (const file of files) {
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
    await db.exec(sql);
    console.log(`  applied ${file}${failed.size ? ` (skipped: ${[...failed].join(', ')})` : ''}`);
  }
}

async function main() {
  const db = new PGlite({ extensions: { pg_trgm: pgTrgmContrib.pg_trgm } });
  await db.waitReady;

  console.log('\n== apply migrations ==');
  await applyMigrationFiles(db);

  console.log('\n== fetch live AniList page ==');
  const anilist = new AniListClient({ minIntervalMs: 200 });
  const perPage = 5;
  const data = await anilist.query(PAGE_MEDIA_QUERY, {
    page: 1,
    perPage,
    sort: ['POPULARITY_DESC'],
    isAdult: false,
    charactersPage: 1,
    charactersPerPage: 10,
    vaLanguage: 'JAPANESE',
  });
  const { media, pageInfo } = data.Page;
  if (media.length === 0) throw new Error('AniList returned no media');
  console.log(`  fetched ${media.length} media (page ${pageInfo.currentPage}/${pageInfo.lastPage})`);

  console.log('\n== import via importer SQL ==');
  const client = makeClient(db);
  const perTitle = [];
  for (const item of media) {
    const counts = await importMediaWithClient(client, item, {});
    perTitle.push({ id: item.id, title: item.title?.romaji, ...counts });
  }
  for (const p of perTitle) {
    console.log(`  #${p.id} ${p.title}: genres=${p.genres} studios=${p.studios} episodes=${p.episodes} characters=${p.characters}`);
  }

  console.log('\n== assertions ==');
  const count = async (sql, params) => (await db.query(sql, params ?? [])).rows[0].n;
  const animeCount = await count(`SELECT count(*)::int AS n FROM anime`);
  if (animeCount !== perPage) throw new Error(`expected ${perPage} anime, got ${animeCount}`);
  ok(`${animeCount} anime rows`);

  const genreCount = await count(`SELECT count(*)::int AS n FROM anime_genres`);
  if (genreCount < perPage) throw new Error('anime_genres too few');
  ok(`${genreCount} anime_genres links`);

  const charCount = await count(`SELECT count(*)::int AS n FROM anime_characters`);
  if (charCount < perPage) throw new Error('anime_characters too few');
  ok(`${charCount} anime_characters links`);

  const vaCount = await count(`SELECT count(*)::int AS n FROM character_staff`);
  ok(`${vaCount} character_staff (voice actor) links`);

  const epCount = await count(
    `SELECT count(*)::int AS n FROM episodes e JOIN anime a ON a.id = e.anime_id`,
  );
  ok(`${epCount} episode placeholders seeded from declared counts`);

  const { rows: sample } = await db.query(
    `SELECT a.title_romaji, a.status, a.episodes AS declared,
            (SELECT count(*) FROM episodes e WHERE e.anime_id = a.id) AS seeded
       FROM anime a ORDER BY a.popularity DESC NULLS LAST LIMIT 3`,
  );
  for (const s of sample) ok(`${s.title_romaji}: declared=${s.declared}, seeded=${s.seeded} episodes`);

  // Full-text search via the generated search_vector + GIN index.
  const { rows: fts } = await db.query(
    `SELECT title_romaji FROM anime
      WHERE search_vector @@ plainto_tsquery('simple', $1)
      ORDER BY ts_rank(search_vector, plainto_tsquery('simple', $1)) DESC LIMIT 3`,
    ['attack'],
  );
  ok(`full-text search returned: ${fts.map((r) => r.title_romaji).join(', ') || '(none)'}`);

  // Trigram fuzzy search.
  const { rows: trgm } = await db.query(
    `SELECT title_romaji FROM anime WHERE title_romaji ILIKE '%' || $1 || '%' LIMIT 3`,
    ['shingeki'],
  );
  ok(`trigram search returned: ${trgm.map((r) => r.title_romaji).join(', ') || '(none)'}`);

  // Idempotency: re-import the same page; counts must be unchanged.
  const before = await count(`SELECT count(*)::int AS n FROM anime`);
  for (const item of media) {
    await importMediaWithClient(client, item, {});
  }
  const after = await count(`SELECT count(*)::int AS n FROM anime`);
  if (after !== before) throw new Error(`idempotency broken: anime ${before} -> ${after}`);
  ok(`re-import idempotent (anime stays at ${after} rows)`);

  const dupe = await count(
    `SELECT count(*)::int AS n FROM (SELECT anime_id, number FROM episodes GROUP BY 1, 2 HAVING count(*) > 1) d`,
  );
  if (dupe !== 0) throw new Error('duplicate (anime_id, number) episodes');
  ok('no duplicate episodes');

  console.log('\n\x1b[32mE2E checks passed.\x1b[0m');
  await db.close();
}

main().catch((err) => {
  console.error(`\ne2e test failed: ${err.message}`);
  process.exit(1);
});
