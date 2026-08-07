// HTTP-layer throughput bench: real Express stack with fast fakes.
//   npm run bench
import { createApp } from '../../src/app.js';
import { TtlCache } from '../../src/lib/cache.js';

const animeService = {
  list: async () => ({ data: [{ id: 1, titleRomaji: 'Cowboy Bebop' }], meta: { page: 1, limit: 25, total: 1 } }),
  getById: async (id) => ({ id, titleRomaji: 'Cowboy Bebop' }),
  search: async () => ({ data: [], meta: { page: 1, limit: 25, total: 0 } }),
  listTrending: async () => ({ data: [], meta: {} }),
  listPopular: async () => ({ data: [], meta: {} }),
  listRecent: async () => ({ data: [], meta: {} }),
  listByGenre: async () => ({ data: [], meta: {} }),
  listByStudio: async () => ({ data: [], meta: {} }),
  getEpisodes: async () => ({ data: [], meta: {} }),
};
const authService = {
  register: async () => { const e = new Error('conflict'); e.status = 409; e.expose = true; throw e; },
  login: async () => { throw Object.assign(new Error('unauthorized'), { status: 401, expose: true }); },
};
const userService = {
  getProfile: async () => ({ id: 'u1', username: 'alice' }),
  listFavorites: async () => ({ data: [], meta: {} }),
  listHistory: async () => ({ data: [], meta: {} }),
  listContinueWatching: async () => ({ data: [], meta: {} }),
};
const watchService = { watch: async () => ({ url: 'http://stream/x' }), prefetch: async () => ({}) };
const malService = { me: async () => ({ connected: false, user: null }) };

const app = createApp({
  animeService, authService, userService, watchService, malService,
  cache: new TtlCache({ ttlMs: 0 }),
  authLimiter: (req, res, next) => next(),
});
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

async function bench(name, url, concurrency, total) {
  const started = Date.now();
  let ok = 0, fail = 0;
  const times = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i = 0; i < Math.ceil(total / concurrency); i += 1) {
      const t0 = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`);
        res.status < 500 ? (ok += 1) : (fail += 1);
      } catch { fail += 1; }
      times.push(performance.now() - t0);
    }
  }));
  const ms = Date.now() - started;
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)].toFixed(1);
  const p95 = times[Math.floor(times.length * 0.95)].toFixed(1);
  const p99 = times[Math.floor(times.length * 0.99)].toFixed(1);
  console.log(`${name.padEnd(34)} ${String(ok + fail).padStart(6)} req  ${String(ms).padStart(5)}ms  ${((ok + fail) / ms * 1000).toFixed(0).padStart(5)} rps  p50=${p50}ms p95=${p95}ms p99=${p99}ms  errors=${fail}`);
}

console.log('--- HTTP-layer throughput (fakes; real Express + zod) ---');
await bench('GET /api/anime (list)', '/api/anime?limit=25', 25, 500);
await bench('GET /api/anime/:id', '/api/anime/1', 25, 500);
await bench('GET /api/anime/search?q=cow', '/api/anime/search?q=cow', 25, 500);
await bench('GET /api/anime/1/episodes', '/api/anime/1/episodes', 25, 500);
await bench('POST /api/auth/register', '/api/auth/register', 10, 200);
await bench('GET /api/watch/1/1', '/api/watch/1/1', 25, 500);
await bench('GET /api/anime/1 (c=200)', '/api/anime/1', 200, 1000);
server.close();
