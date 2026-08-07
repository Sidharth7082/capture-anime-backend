// E2E audit database: PGlite (WASM Postgres) serving the REAL migrations
// 0001-0013 on a PostgreSQL wire protocol socket. pg_trgm operators are
// skipped (not available in WASM) — everything else is the true schema.
import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch } from '@electric-sql/pglite-pg_textsearch';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const MIGRATIONS_DIR = path.join(repoRoot, 'db/migrations');

// Split a migration file into statements, honoring '...' strings, -- comments,
// and $$...$$ / $tag$...$tag$ dollar quoting (used by trigger functions).
export function splitStatements(sql) {
  const stmts = [];
  let buf = '';
  let i = 0;
  let inDollar = null;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const rest = sql.slice(i);
    if (inDollar) {
      if (rest.startsWith(inDollar)) {
        buf += inDollar;
        i += inDollar.length;
        inDollar = null;
      } else {
        buf += c;
        i += 1;
      }
    } else if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      buf += sql.slice(i, nl + 1);
      i = nl + 1;
    } else if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") { j += 1; break; }
        else j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (m) {
        inDollar = m[0];
        buf += m[0];
        i += m[0].length;
      } else {
        buf += c;
        i += 1;
      }
    } else if (c === ';') {
      const trimmed = buf.trim();
      if (trimmed) stmts.push(trimmed);
      buf = '';
      i += 1;
    } else {
      buf += c;
      i += 1;
    }
  }
  const trimmed = buf.trim();
  if (trimmed) stmts.push(trimmed);
  return stmts;
}

const SKIP = /CREATE EXTENSION|gin_trgm_ops/i;

/** Boot the E2E database. Resolves to the socket server. */
export async function startE2eDb({ port = 54329, host = '127.0.0.1' } = {}) {
  const db = await PGlite.create({ extensions: { textsearch: pg_textsearch } });

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.up.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitStatements(sql).filter((s) => !SKIP.test(s));
    for (const stmt of stmts) await db.exec(stmt);
  }

  const seedSql = readFileSync(path.join(here, 'seed.sql'), 'utf8');
  for (const stmt of splitStatements(seedSql)) await db.exec(stmt);

  const server = new PGLiteSocketServer({ db, port, host, maxConnections: 20 });
  await server.start();
  return { server, db, port, host };
}
