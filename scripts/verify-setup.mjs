// ============================================================================
// Setup verification: connection test + table/index/sequence checks.
//
//   node scripts/verify-setup.mjs
// ============================================================================
import 'dotenv/config';
import pg from 'pg';

const EXPECTED_TABLES = [
  'users', 'anime', 'genres', 'anime_genres', 'studios', 'anime_studios',
  'characters', 'anime_characters', 'staff', 'character_staff', 'episodes',
  'favorites', 'watchlists', 'watch_history', 'ratings', 'comments',
  'schema_migrations',
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// 1. Connection test
const { rows: [version] } = await client.query('SELECT version()');
console.log(`connection OK -> ${version.version.split(' on ')[0]}`);

// 2. Table existence
const { rows: tables } = await client.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
);
const actual = new Set(tables.map((r) => r.table_name));
const missing = EXPECTED_TABLES.filter((t) => !actual.has(t));
console.log(`tables: ${actual.size} found in public schema`);
if (missing.length > 0) {
  console.error(`MISSING TABLES: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`verified: all ${EXPECTED_TABLES.length} expected tables exist`);

// 3. Supporting objects
const { rows: [indexes] } = await client.query(
  `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public'`,
);
const { rows: [sequences] } = await client.query(
  `SELECT count(*)::int AS n FROM pg_sequences WHERE schemaname = 'public'`,
);
const { rows: [enums] } = await client.query(
  `SELECT count(*)::int AS n FROM pg_type WHERE typtype = 'e' AND typname NOT LIKE '\\_%'`,
);
console.log(`indexes: ${indexes.n} | sequences: ${sequences.n} | enum types: ${enums.n}`);

await client.end();
console.log('\nsetup verification passed');
