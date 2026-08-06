// ============================================================================
// Minimal, dependency-light migration runner for plain SQL migrations.
//
//   node db/migrate.js up             apply all pending migrations
//   node db/migrate.js down           roll back the most recent migration
//   node db/migrate.js status         list applied / pending migrations
//   node db/migrate.js create <name>  scaffold new <seq>_<name>.up/.down.sql
//
// Migration files live in db/migrations/ and are named:
//   <seq>_<name>.up.sql     e.g. 0001_core_schema.up.sql
//   <seq>_<name>.down.sql
//
// Behaviour:
//   * Applied migrations are recorded in the `schema_migrations` table.
//   * Each migration runs inside a single transaction — Postgres DDL is
//     transactional, so a failed migration rolls back completely.
//   * A session-level advisory lock prevents two runners from migrating the
//     same database concurrently.
//   * `down` refuses to run unless a .down.sql file exists (no guessing).
// ============================================================================

import 'dotenv/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_KEY = 'anime_platform_migrations';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function loadMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  const byName = new Map();

  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.(up|down)\.sql$/);
    if (!match) continue;
    const [, seq, name, direction] = match;
    const key = `${seq}_${name}`;
    if (!byName.has(key)) {
      byName.set(key, { seq: Number(seq), name, up: null, down: null });
    }
    byName.get(key)[direction] = path.join(MIGRATIONS_DIR, file);
  }

  return [...byName.values()].sort(
    (a, b) => a.seq - b.seq || a.name.localeCompare(b.name),
  );
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedNames(client) {
  const { rows } = await client.query(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  return new Set(rows.map((r) => r.name));
}

async function runMigration(client, migration, direction) {
  const file = migration[direction];
  const sql = await readFile(file, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (direction === 'up') {
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
        [migration.name],
      );
    } else {
      await client.query(
        `DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`,
        [migration.name],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${direction === 'up' ? 'applying' : 'reverting'} ${migration.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function up(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [LOCK_KEY]);
    await ensureMigrationsTable(client);
    await client.query('COMMIT');

    const applied = await appliedNames(client);
    const migrations = await loadMigrations();
    const pending = migrations.filter(
      (m) => !applied.has(m.name) && m.up,
    );

    if (pending.length === 0) {
      console.log('Nothing to migrate — database is up to date.');
      return;
    }

    for (const migration of pending) {
      process.stdout.write(`applying ${migration.name} ... `);
      await runMigration(client, migration, 'up');
      console.log('ok');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function down(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [LOCK_KEY]);
    await ensureMigrationsTable(client);
    await client.query('COMMIT');

    const applied = await appliedNames(client);
    if (applied.size === 0) {
      console.log('No migrations applied — nothing to roll back.');
      return;
    }

    const migrations = await loadMigrations();
    const lastApplied = [...applied].sort().at(-1);
    const migration = migrations.find((m) => m.name === lastApplied);

    if (!migration?.down) {
      die(`no down migration exists for ${lastApplied}; refusing to guess`);
    }

    process.stdout.write(`reverting ${lastApplied} ... `);
    await runMigration(client, migration, 'down');
    console.log('ok');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function status(pool) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedNames(client);
    const migrations = await loadMigrations();

    for (const m of migrations) {
      const state = applied.has(m.name) ? 'applied ' : 'pending ';
      const upMark = m.up ? 'up  ' : 'NO-UP ';
      const downMark = m.down ? 'down' : 'NO-DOWN';
      console.log(`  ${state} ${m.name.padEnd(40)} ${upMark} ${downMark}`);
    }
  } finally {
    client.release();
  }
}

async function create(name) {
  if (!name) die('usage: node db/migrate.js create <migration_name>');
  if (!/^[a-z0-9_]+$/.test(name)) {
    die('migration name must be lowercase snake_case (letters, digits, underscore)');
  }

  const migrations = await loadMigrations();
  const nextSeq = (migrations.at(-1)?.seq ?? 0) + 1;
  const base = `${String(nextSeq).padStart(4, '0')}_${name}`;

  for (const direction of ['up', 'down']) {
    const file = path.join(MIGRATIONS_DIR, `${base}.${direction}.sql`);
    await writeFile(
      file,
      `-- ${base}.${direction}.sql\n\n-- TODO: write the ${direction} migration\n`,
      'utf8',
    );
    console.log(`created ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [command = 'up', arg] = process.argv.slice(2);

if (command === 'create') {
  await create(arg);
  process.exit(0);
}

if (!['up', 'down', 'status'].includes(command)) {
  die(`unknown command "${command}" (expected up, down, status or create)`);
}

if (!process.env.DATABASE_URL) {
  die('DATABASE_URL is not set (see .env.example)');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  if (command === 'up') await up(pool);
  if (command === 'down') await down(pool);
  if (command === 'status') await status(pool);
} catch (err) {
  die(err.message);
} finally {
  await pool.end();
}
