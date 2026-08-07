// E2E orchestrator: boots the PGlite wire DB + the real Express backend as a
// child process, waits for /health, runs the audit suite, tears everything
// down. Usage: npm run test:e2e  (set API_PORT/DB_PORT to override).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startE2eDb } from './db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const API_PORT = Number(process.env.API_PORT ?? 3100);
const DB_PORT = Number(process.env.DB_PORT ?? 54329);
const BASE = `http://127.0.0.1:${API_PORT}`;

function waitForHealth(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() - started > timeoutMs) return reject(new Error(`backend did not become healthy at ${url}`));
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      setTimeout(tick, 300);
    };
    tick();
  });
}

const backend = spawn(process.execPath, ['src/server.js'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_URL: `postgres://postgres@127.0.0.1:${DB_PORT}/postgres`,
    PORT: String(API_PORT),
    NODE_ENV: 'development',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    AUTH_RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_MAX: '1000000',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (d) => { backendLog += d; });
backend.stderr.on('data', (d) => { backendLog += d; });

let db;
let code = 1;
try {
  db = await startE2eDb({ port: DB_PORT });
  console.log(`[e2e] db on 127.0.0.1:${DB_PORT}`);
  await waitForHealth(`${BASE}/health`);
  console.log(`[e2e] backend healthy on ${BASE}`);

  const { runAudit } = await import('./audit.mjs');
  code = await runAudit(BASE);
} catch (err) {
  console.error('[e2e] setup failed:', err.message);
  if (backendLog) console.error(backendLog.slice(-4000));
} finally {
  backend.kill('SIGTERM');
  await new Promise((r) => backend.once('exit', r));
  await db?.server.stop();
  await db?.db.close();
}
process.exit(code);
