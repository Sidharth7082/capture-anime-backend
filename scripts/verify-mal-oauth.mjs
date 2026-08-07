// E2E verification of the MAL OAuth flow through the REAL Express app:
// real MalService (real PKCE, real AES-GCM encryption) + real HTTP against a
// local mock of myanimelist.net, wired into createApp with the real JWT auth.
import './_mal-e2e-env.mjs';
import http from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { TtlCache } from '../src/lib/cache.js';
import { MalService } from '../src/modules/mal/mal.service.js';
import { signAccessToken } from '../src/lib/jwt.js';

const MOCK_PORT = 4999;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

// --- mock MAL server --------------------------------------------------------
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, MOCK_BASE);
  const bodyStr = await readBody(req);
  const form = new URLSearchParams(bodyStr);
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/token') {
    if (form.get('grant_type') === 'authorization_code') {
      return json(200, { access_token: 'mal-at', refresh_token: 'mal-rt', expires_in: 3600 });
    }
    if (form.get('grant_type') === 'refresh_token') {
      return json(200, { access_token: 'mal-at-2', refresh_token: 'mal-rt-2', expires_in: 3600 });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!bearer) return json(401, { error: 'no token' });
  if (url.pathname === '/users/@me') return json(200, { id: 4242, name: 'mock_user', picture: 'http://p.jpg' });
  if (url.pathname === '/users/@me/animelist') {
    const offset = Number(url.searchParams.get('offset') || 0);
    const page = offset === 0
      ? [
          { node: { id: 16498 }, list_status: { status: 'watching', score: 9, num_episodes_watched: 5, is_rewatching: false, rewatch_count: 0, updated_at: '2026-01-01T00:00:00+00:00' } },
          { node: { id: 5114 }, list_status: { status: 'completed', score: 10, num_episodes_watched: 64, updated_at: '2026-01-02T00:00:00+00:00' } },
        ]
      : [];
    return json(200, { data: page, paging: offset === 0 ? { next: 'x' } : undefined });
  }
  if (url.pathname.includes('/my_list_status')) {
    if (req.method === 'PATCH') {
      return json(200, {
        status: form.get('status') ?? 'watching',
        score: Number(form.get('score') ?? 8),
        num_episodes_watched: Number(form.get('num_watched_episodes') ?? 3),
        is_rewatching: form.get('is_rewatching') === 'true',
        rewatch_count: Number(form.get('num_times_rewatched') ?? 0),
        updated_at: '2026-02-01T00:00:00+00:00',
      });
    }
    if (req.method === 'DELETE') return json(200, {});
  }
  return json(404, { error: `no route ${req.method} ${url.pathname}` });
});

function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
}

await new Promise((r) => mock.listen(MOCK_PORT, r));

// --- real app wiring --------------------------------------------------------
const fakeRepo = {
  account: null,
  entries: [],
  upsertAccount: async (a) => { fakeRepo.account = a; return a; },
  findAccountByUser: async () => fakeRepo.account,
  deleteAccount: async () => { fakeRepo.account = null; fakeRepo.entries = []; return true; },
  findAnimeIdByMalId: async (malId) => (malId === 16498 ? 1 : null),
  upsertEntry: async (_u, e) => { const i = fakeRepo.entries.findIndex((x) => x.malAnimeId === e.malAnimeId); if (i >= 0) fakeRepo.entries[i] = { ...fakeRepo.entries[i], ...e }; else fakeRepo.entries.push(e); return e; },
  listEntries: async (_u, { status = null, limit, offset }) => {
    const items = fakeRepo.entries.filter((e) => !status || e.status === status).slice(offset, offset + limit);
    return { items, total: items.length };
  },
  findEntry: async () => fakeRepo.entries.find((e) => e.malAnimeId === 16498) ?? null,
  findEntryByAnimeId: async (_u, animeId) => fakeRepo.entries.find((e) => e.animeId === animeId) ?? null,
  deleteEntry: async (_u, malAnimeId) => { fakeRepo.entries = fakeRepo.entries.filter((e) => e.malAnimeId !== malAnimeId); return 1; },
  deleteEntriesExcept: async (_u, keep) => {
    const before = fakeRepo.entries.length;
    fakeRepo.entries = fakeRepo.entries.filter((e) => keep.includes(e.malAnimeId));
    return before - fakeRepo.entries.length;
  },
};

// Redirect MAL calls to the mock instead of the real myanimelist.net.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).replace('https://myanimelist.net/v1/oauth2', MOCK_BASE).replace('https://api.myanimelist.net/v2', MOCK_BASE), init);

const malService = new MalService({ repository: fakeRepo, fetchImpl: globalThis.fetch });
const app = createApp({
  authService: { register: async () => ({}), login: async () => ({}), refresh: async () => ({}), logout: async () => ({}) },
  animeService: { list: async () => ({ data: [], meta: {} }) },
  userService: { getProfile: async () => ({}), listFavorites: async () => ({ data: [], meta: {} }) },
  malService,
  cache: new TtlCache({ ttlMs: 0 }),
});

// --- drive the flow ---------------------------------------------------------
const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
const AUTH = { Authorization: `Bearer ${token}` };
const results = [];
const check = (name, cond, extra = '') => { results.push([name, cond]); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

// 1. connect
const connect = await request(app).get('/api/mal/connect').set(AUTH);
check('connect 302s to MAL authorize', connect.status === 302);
const cookie = connect.headers['set-cookie']?.[0]?.split(';')[0];
check('connect sets signed httpOnly cookie', Boolean(cookie) && connect.headers['set-cookie'][0].includes('HttpOnly'));
const authorizeUrl = new URL(connect.headers.location);
const challenge = authorizeUrl.searchParams.get('code_challenge');
const state = authorizeUrl.searchParams.get('state');
check('authorize has PKCE S256 challenge', challenge?.length > 40);
check('authorize declares S256 method', authorizeUrl.searchParams.get('code_challenge_method') === 'S256');
check('authorize has state', Boolean(state));

// 2. callback (simulate MAL redirect)
const cb = await request(app).get(`/api/mal/callback?code=mock-code&state=${state}`).set('Cookie', cookie);
check('callback redirects to frontend #mal=connected', cb.status === 302 && cb.headers.location.endsWith('#mal=connected'));
check('tokens stored ENCRYPTED', fakeRepo.account?.accessTokenEnc && !fakeRepo.account.accessTokenEnc.includes('mal-at'));

// 3. me
const me = await request(app).get('/api/mal/me').set(AUTH);
check('me reports connected', me.status === 200 && me.body.connected === true && me.body.user.name === 'mock_user');

// 4. sync
const sync = await request(app).post('/api/mal/sync').set(AUTH);
check('sync pulled 2 entries, matched 1', sync.status === 200 && sync.body.synced === 2 && sync.body.matched === 1, JSON.stringify(sync.body));

// 5. list (filtered)
const list = await request(app).get('/api/mal/list?status=watching').set(AUTH);
check('list filters by status', list.status === 200 && list.body.data.length === 1 && list.body.data[0].status === 'watching');

// 6. update entry
const upd = await request(app).put('/api/mal/list/16498').set(AUTH).send({ score: 10, episodesWatched: 25 });
check('update entry round-trips to MAL', upd.status === 200 && upd.body.entry.score === 10 && upd.body.entry.episodesWatched === 25);

// 7. auto-progress
const prog = await request(app).post('/api/mal/progress').set(AUTH).send({ animeId: 1, episodeNumber: 26 });
check('player progress auto-updates MAL', prog.status === 200 && prog.body.updated === true);

// 8. add + remove
const add = await request(app).post('/api/mal/list').set(AUTH).send({ malAnimeId: 5114, status: 'plan_to_watch' });
check('add entry', add.status === 200);
const del = await request(app).delete('/api/mal/list/16498').set(AUTH);
check('remove entry', del.status === 200);

// 9. disconnect
const disc = await request(app).post('/api/mal/disconnect').set(AUTH);
const meAfter = await request(app).get('/api/mal/me').set(AUTH);
check('disconnect clears account', disc.status === 200 && meAfter.body.connected === false);

// 10. unauthenticated
const anon = await request(app).get('/api/mal/me');
check('protected route 401s without token', anon.status === 401);

const failed = results.filter(([, c]) => !c).length;
console.log(failed === 0 ? '\nALL MAL OAUTH E2E CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
mock.close();
process.exit(failed === 0 ? 0 : 1);
