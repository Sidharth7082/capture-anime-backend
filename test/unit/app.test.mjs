import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { TtlCache } from '../../src/lib/cache.js';
import { ApiError } from '../../src/lib/errors.js';
import { signAccessToken } from '../../src/lib/jwt.js';

const META = { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false };
const ANIME_ITEM = { id: 1, anilistId: 16498, titleRomaji: 'Shingeki no Kyojin', genres: [] };

function makeFakes(overrides = {}) {
  const animeService = {
    list: async () => ({ data: [ANIME_ITEM], meta: META }),
    getById: async (id) => {
      if (id !== 1) throw ApiError.notFound(`Anime ${id} not found`);
      return { ...ANIME_ITEM, characters: [], studios: [], rating: { count: 0, average: 0 }, episodeCount: 25 };
    },
    trending: async () => ({ data: [ANIME_ITEM], meta: META }),
    popular: async () => ({ data: [ANIME_ITEM], meta: META }),
    recent: async () => ({ data: [ANIME_ITEM], meta: META }),
    search: async () => ({ data: [ANIME_ITEM], meta: META }),
    byGenre: async (id) => (id === 5 ? { genre: { id: 5, name: 'Action' }, data: [], meta: META } : Promise.reject(ApiError.notFound('Genre 5 not found'))),
    byStudio: async (id) => (id === 6 ? { studio: { id: 6, name: 'MAPPA' }, data: [], meta: META } : Promise.reject(ApiError.notFound('Studio 6 not found'))),
    episodes: async (animeId) => (animeId === 1 ? { animeId, data: [{ id: 1, number: 1 }], meta: META } : Promise.reject(ApiError.notFound(`Anime ${animeId} not found`))),
    ...overrides.anime,
  };

  const authService = {
    register: async () => ({ user: { id: 'u1', username: 'alice' }, tokens: { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 900 } }),
    login: async () => ({ user: { id: 'u1', username: 'alice' }, tokens: { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 900 } }),
    refresh: async () => ({ user: { id: 'u1', username: 'alice' }, tokens: { accessToken: 'a2', refreshToken: 'r2', tokenType: 'Bearer', expiresIn: 900 } }),
    logout: async () => ({ success: true }),
    ...overrides.auth,
  };

  const userService = {
    getProfile: async () => ({ id: 'u1', username: 'alice', email: 'alice@example.com', role: 'viewer' }),
    listFavorites: async () => ({ data: [], meta: META }),
    addFavorite: async () => ({ id: 1, created: true }),
    removeFavorite: async () => ({ success: true }),
    listHistory: async () => ({ data: [], meta: META }),
    addHistory: async () => ({ history: { id: 1, episodeId: 42 } }),
    listContinueWatching: async () => ({
      data: [{ id: 1, animeId: 7, episodeNumber: 3, playbackPositionSeconds: 150, durationSeconds: 1440, anime: { id: 7, title: 'AoT' } }],
      meta: META,
    }),
    saveContinueWatching: async (userId, animeId, body) => ({
      animeId,
      episodeNumber: body.episodeNumber,
      playbackPositionSeconds: body.playbackPositionSeconds,
    }),
    removeContinueWatching: async () => ({ success: true }),
    ...overrides.user,
  };

  const watchService = {
    ...overrides.watch,
  };

  const malService = {
    configured: true,
    configStatus: () => ({ configured: true, missing: [] }),
    buildAuthorizeUrl: async (userId) => ({
      authorizeUrl: 'https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id=x&code_challenge=ch&code_challenge_method=S256&state=s',
      state: 's',
    }),
    handleCallback: async () => ({ malUser: { id: 123, name: 'tester' } }),
    getMe: async () => ({ connected: true, user: { id: 123, name: 'tester', picture: null } }),
    disconnect: async () => ({ success: true }),
    syncList: async () => ({ synced: 2, matched: 1, removed: 0 }),
    listEntries: async () => ({ items: [{ malAnimeId: 16498, status: 'watching' }], total: 1 }),
    updateEntry: async (userId, malAnimeId, patch) => ({ malAnimeId, entry: { ...patch } }),
    addEntry: async (userId, body) => ({ malAnimeId: body.malAnimeId, entry: body }),
    removeEntry: async () => ({ success: true }),
    updateProgress: async () => ({ updated: false, reason: 'not_on_mal_list' }),
    ...overrides.mal,
  };

  return { animeService, authService, userService, watchService, malService };
}

function buildApp(overrides, cache, cacheTtlMs) {
  const fakes = makeFakes(overrides);
  return createApp({
    ...fakes,
    cache: cache ?? new TtlCache({ ttlMs: 0 }),
    cacheTtlMs: cacheTtlMs ?? 0,
  });
}
test('GET /api/anime returns paginated envelope', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/anime?page=1&limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.data[0].titleRomaji, 'Shingeki no Kyojin');
  assert.deepEqual(res.body.meta, META);
  // caching is disabled (cacheTtlMs 0): no X-Cache header is emitted
  assert.equal(res.headers['x-cache'], undefined);
});

test('GET /api/anime is cached on repeat', async () => {
  const cache = new TtlCache({ ttlMs: 60_000 });
  let calls = 0;
  const app = buildApp({
    anime: {
      list: async () => {
        calls += 1;
        return { data: [ANIME_ITEM], meta: META };
      },
    },
  }, cache, 60_000);

  const first = await request(app).get('/api/anime');
  const second = await request(app).get('/api/anime');
  assert.equal(first.headers['x-cache'], 'MISS');
  assert.equal(second.headers['x-cache'], 'HIT');
  assert.equal(calls, 1);
});

test('GET /api/anime/:id returns detail and 404s for missing', async () => {
  const app = buildApp();
  const ok = await request(app).get('/api/anime/1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.episodeCount, 25);

  const missing = await request(app).get('/api/anime/999');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('GET /api/anime/:id with non-numeric id returns 400 validation error', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/anime/abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('GET /api/anime/search requires q', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/anime/search');
  assert.equal(res.status, 400);
});

test('GET /api/anime/genre/:id and studio/:id', async () => {
  const app = buildApp();
  const genre = await request(app).get('/api/anime/genre/5');
  assert.equal(genre.status, 200);
  assert.equal(genre.body.genre.name, 'Action');

  const studio = await request(app).get('/api/anime/studio/6');
  assert.equal(studio.status, 200);
  assert.equal(studio.body.studio.name, 'MAPPA');

  assert.equal((await request(app).get('/api/anime/genre/99')).status, 404);
  assert.equal((await request(app).get('/api/anime/studio/99')).status, 404);
});

test('GET /api/episodes/:animeId', async () => {
  const app = buildApp();
  assert.equal((await request(app).get('/api/episodes/1')).status, 200);
  assert.equal((await request(app).get('/api/episodes/999')).status, 404);
});

test('POST /api/auth/register validates body', async () => {
  const app = buildApp();
  const bad = await request(app).post('/api/auth/register').send({ username: 'x', email: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const good = await request(app).post('/api/auth/register').send({
    username: 'alice_1',
    email: 'alice@example.com',
    password: 'correct-password',
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.tokens.tokenType, 'Bearer');
});

test('POST /api/auth/login invalid credentials shape', async () => {
  const app = buildApp();
  const res = await request(app).post('/api/auth/login').send({ identifier: 'alice', password: '' });
  assert.equal(res.status, 400);
});

test('POST /api/auth/refresh without token returns 401', async () => {
  const app = buildApp({
    auth: {
      refresh: async () => {
        throw ApiError.unauthorized('Refresh token required');
      },
    },
  });
  const res = await request(app).post('/api/auth/refresh').send({});
  assert.equal(res.status, 401);
});

test('POST /api/auth/logout', async () => {
  const app = buildApp();
  const res = await request(app).post('/api/auth/logout').send({ refreshToken: 'r' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('user endpoints require a bearer token', async () => {
  const app = buildApp();
  for (const path of [
    '/api/user/profile',
    '/api/user/favorites',
    '/api/user/history',
    '/api/user/continue-watching',
  ]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 401, `${path} should be protected`);
  }
  const put = await request(app).put('/api/user/continue-watching/1').send({});
  assert.equal(put.status, 401, 'PUT continue-watching should be protected');
});

test('user endpoints accept a valid access token', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });

  const profile = await request(app).get('/api/user/profile').set('Authorization', `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.username, 'alice');

  const favorites = await request(app).get('/api/user/favorites').set('Authorization', `Bearer ${token}`);
  assert.equal(favorites.status, 200);
});

test('POST /api/user/favorites requires exactly one target', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  const none = await auth(request(app).post('/api/user/favorites')).send({});
  assert.equal(none.status, 400);

  const two = await auth(request(app).post('/api/user/favorites')).send({ animeId: 1, staffId: 2 });
  assert.equal(two.status, 400);

  const one = await auth(request(app).post('/api/user/favorites')).send({ animeId: 1 });
  assert.equal(one.status, 201);
});

test('DELETE /api/user/favorites/:id validates id', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const res = await request(app)
    .delete('/api/user/favorites/not-a-number')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
});

test('POST /api/user/history records a watched episode', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });

  const ok = await request(app)
    .post('/api/user/history')
    .set('Authorization', `Bearer ${token}`)
    .send({ animeId: 7, episode: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.history.episodeId, 42);

  const bad = await request(app)
    .post('/api/user/history')
    .set('Authorization', `Bearer ${token}`)
    .send({ animeId: 'x' });
  assert.equal(bad.status, 400);
});

test('continue-watching list, save and remove', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  const list = await auth(request(app).get('/api/user/continue-watching'));
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].animeId, 7);

  const save = await auth(request(app).put('/api/user/continue-watching/7')).send({
    episodeNumber: 3,
    playbackPositionSeconds: 150,
    durationSeconds: 1440,
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.playbackPositionSeconds, 150);

  const invalid = await auth(request(app).put('/api/user/continue-watching/7')).send({
    episodeNumber: 0, // must be >= 1
    playbackPositionSeconds: -1,
  });
  assert.equal(invalid.status, 400);

  const removed = await auth(request(app).delete('/api/user/continue-watching/7'));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { success: true });
});

test('unknown routes return a JSON 404', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('mal connect requires auth and returns the authorize URL as JSON', async () => {
  const app = buildApp();
  const anon = await request(app).get('/api/mal/connect');
  assert.equal(anon.status, 401, 'connect must be JWT-protected');

  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const res = await request(app).get('/api/mal/connect').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.match(res.body.authorizeUrl, /^https:\/\/myanimelist\.net\/v1\/oauth2\/authorize/);
  assert.ok(res.body.authorizeUrl.includes('code_challenge_method=S256'));
  assert.ok(res.body.authorizeUrl.includes('state='));
});

test('mal callback without code/state redirects with an error hash', async () => {
  const app = buildApp();
  const denied = await request(app).get('/api/mal/callback?error=access_denied');
  assert.equal(denied.status, 302);
  assert.match(denied.headers.location, /#mal=denied$/);

  const missing = await request(app).get('/api/mal/callback?state=s');
  assert.equal(missing.status, 302);
  assert.match(missing.headers.location, /#mal=error$/);
});

test('mal callback with code+state redirects to the frontend connected', async () => {
  const app = buildApp();
  const res = await request(app).get('/api/mal/callback?code=x&state=s');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /#mal=connected$/);
});

test('mal endpoints require auth and validate input', async () => {
  const app = buildApp();
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  assert.equal((await request(app).get('/api/mal/me')).status, 401);
  assert.equal((await request(app).get('/api/mal/list')).status, 401);

  const me = await auth(request(app).get('/api/mal/me'));
  assert.equal(me.status, 200);
  assert.equal(me.body.connected, true);

  const list = await auth(request(app).get('/api/mal/list?status=watching'));
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].malAnimeId, 16498);

  const badStatus = await auth(request(app).get('/api/mal/list?status=bogus'));
  assert.equal(badStatus.status, 400);

  const emptyPatch = await auth(request(app).put('/api/mal/list/16498')).send({});
  assert.equal(emptyPatch.status, 400);

  const add = await auth(request(app).post('/api/mal/list')).send({ malAnimeId: 16498, status: 'watching' });
  assert.equal(add.status, 200);

  const badAdd = await auth(request(app).post('/api/mal/list')).send({ status: 'watching' });
  assert.equal(badAdd.status, 400);

  const progress = await auth(request(app).post('/api/mal/progress')).send({ animeId: 1, episodeNumber: 3 });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.updated, false);

  const badProgress = await auth(request(app).post('/api/mal/progress')).send({ animeId: 1 });
  assert.equal(badProgress.status, 400);

  const sync = await auth(request(app).post('/api/mal/sync'));
  assert.equal(sync.status, 200);
  assert.equal(sync.body.synced, 2);

  const remove = await auth(request(app).delete('/api/mal/list/16498'));
  assert.equal(remove.status, 200);
});

test('swagger spec is served', async () => {
  const app = buildApp();
  const json = await request(app).get('/api-docs.json');
  assert.equal(json.status, 200);
  assert.ok(json.body.paths['/api/anime']);
  assert.ok(json.body.paths['/api/auth/login']);
  const ui = await request(app).get('/api-docs/');
  assert.equal(ui.status, 200);
});

test('mal connect reports exactly which env vars are missing (503)', async () => {
  const app = buildApp({
    mal: {
      configStatus: () => ({ configured: false, missing: ['MAL_CLIENT_ID', 'MAL_TOKEN_ENCRYPTION_KEY'] }),
    },
  });
  const token = signAccessToken({ id: 'u1', username: 'alice', role: 'viewer' });
  const res = await request(app).get('/api/mal/connect').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 503);
  assert.match(res.body.error.message, /MAL_CLIENT_ID/);
  assert.match(res.body.error.message, /MAL_TOKEN_ENCRYPTION_KEY/);
});
