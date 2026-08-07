import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MalService, createPkcePair } from '../../../src/modules/mal/mal.service.js';
import { encryptSecret, decryptSecret } from '../../../src/lib/crypto.js';
import { ApiError } from '../../../src/lib/errors.js';

// ---------------------------------------------------------------------------
// Fake MAL HTTP client: an in-memory "MAL" with a token endpoint + API.
// ---------------------------------------------------------------------------
function makeMalHttp({ listPages = [[]], refreshToken = 'rt-1' } = {}) {
  const calls = [];
  let accessToken = 'at-1';
  const http = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.includes('/v1/oauth2/token')) {
      const body = new URLSearchParams(init.body);
      const grant = body.get('grant_type');
      if (grant === 'authorization_code') {
        assert.ok(body.get('code_verifier'), 'PKCE code_verifier must be sent');
        return json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
      }
      if (grant === 'refresh_token') {
        if (body.get('refresh_token') !== refreshToken) {
          return json({ error: 'invalid_grant' }, 400);
        }
        return json({ access_token: 'at-refreshed', refresh_token: 'rt-refreshed', expires_in: 3600 });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.includes('/animelist')) {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      const page = listPages[Math.floor(offset / 1000)] ?? [];
      return json({ data: page, paging: offset + 1000 < listPages.length * 1000 ? { next: 'x' } : undefined });
    }
    if (url.includes('/users/@me')) {
      return json({ id: 123, name: 'tester', picture: 'http://p.jpg' });
    }
    if (url.includes('/my_list_status') && init.method === 'PATCH') {
      const body = new URLSearchParams(init.body);
      return json({
        status: body.get('status') ?? 'watching',
        score: Number(body.get('score') ?? 8),
        num_episodes_watched: Number(body.get('num_watched_episodes') ?? 3),
        is_rewatching: body.get('is_rewatching') === 'true',
        rewatch_count: Number(body.get('num_times_rewatched') ?? 0),
        updated_at: '2026-01-01T00:00:00+00:00',
      });
    }
    if (url.includes('/my_list_status') && init.method === 'DELETE') {
      return json({}, 200);
    }
    return json({ error: `no route ${url}` }, 404);
  };
  return { http, calls };
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------
function makeRepo(overrides = {}) {
  const account = {
    userId: 'u1',
    malId: 123,
    malUsername: 'tester',
    accessTokenEnc: encryptSecret('at-1'),
    refreshTokenEnc: encryptSecret('rt-1'),
    tokenExpiresAt: new Date(Date.now() + 60_000_000), // valid for ~16h
    scopes: 'read write',
  };
  const entries = [];
  return {
    account,
    entries,
    upsertAccount: async (a) => {
      Object.assign(account, a);
      return account;
    },
    findAccountByUser: async () => account,
    deleteAccount: async () => { entries.length = 0; return true; },
    findAnimeIdByMalId: async (malId) => (malId === 16498 ? 1 : null),
    upsertEntry: async (userId, e) => { entries.push(e); return e; },
    listEntries: async () => ({ items: entries, total: entries.length }),
    findEntry: async () => entries[0] ?? null,
    findEntryByAnimeId: async () => entries.find((e) => e.animeId === 1) ?? null,
    deleteEntry: async () => 1,
    deleteEntriesExcept: async () => 0,
    ...overrides,
  };
}

function makeService(repo, http) {
  return new MalService({ repository: repo, fetchImpl: http });
}

test('crypto: encryptSecret/decryptSecret round-trips and fails closed on tamper', () => {
  const enc = encryptSecret('super-secret-token');
  assert.notEqual(enc, 'super-secret-token');
  assert.ok(!enc.includes('super-secret-token'));
  assert.equal(decryptSecret(enc), 'super-secret-token');
  assert.throws(() => decryptSecret('not:valid:payload:here'));
});

test('PKCE pair: verifier is URL-safe 43-128 chars and challenge is S256', async () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('buildAuthorizeUrl includes PKCE params and a signed-cookie payload', () => {
  const { url, payload } = makeService(makeRepo(), makeMalHttp().http).buildAuthorizeUrl('u1');
  const u = new URL(url);
  assert.equal(u.origin, 'https://myanimelist.net');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('code_challenge'));
  assert.equal(payload.userId, 'u1');
  assert.ok(payload.verifier && payload.state);
});

test('handleCallback exchanges the code and stores ENCRYPTED tokens', async () => {
  const repo = makeRepo();
  const { http, calls } = makeMalHttp();
  const svc = makeService(repo, http);
  const { verifier, state } = createPkcePair();
  const out = await svc.handleCallback({ code: 'code-1', state }, { verifier, state, userId: 'u1' });
  assert.equal(out.malUser.name, 'tester');
  assert.equal(decryptSecret(repo.account.accessTokenEnc), 'at-new');
  assert.ok(!repo.account.accessTokenEnc.includes('at-new'), 'plaintext token must not be stored');
  assert.ok(calls.some((c) => c.url.includes('/v1/oauth2/token')));
});

test('handleCallback rejects a state mismatch', async () => {
  const svc = makeService(makeRepo(), makeMalHttp().http);
  const { verifier } = createPkcePair();
  await assert.rejects(
    () => svc.handleCallback({ code: 'x', state: 'wrong' }, { verifier, state: 'expected', userId: 'u1' }),
    (err) => err.status === 400,
  );
});

test('getMe never exposes tokens', async () => {
  const { user } = await makeService(makeRepo(), makeMalHttp().http).getMe('u1');
  assert.deepEqual(Object.keys(user).sort(), ['id', 'name', 'picture', 'tokenExpiresAt']);
  for (const key of ['accessToken', 'refreshToken', 'accessTokenEnc', 'refreshTokenEnc', 'at-1', 'rt-1']) {
    assert.ok(!(key in user) && !JSON.stringify(user).includes(key), `${key} must not leak`);
  }
});

test('syncList pulls every page, matches by id_mal, upserts, prunes', async () => {
  const repo = makeRepo();
  const listPages = [
    [
      { node: { id: 16498 }, list_status: { status: 'watching', score: 9, num_episodes_watched: 5, updated_at: '2026-01-01T00:00:00+00:00' } },
      { node: { id: 99999 }, list_status: { status: 'plan_to_watch', score: 0, num_episodes_watched: 0 } },
    ],
    [
      { node: { id: 77777 }, list_status: { status: 'completed', score: 10, num_episodes_watched: 12 } },
    ],
  ];
  const svc = makeService(repo, makeMalHttp({ listPages }).http);
  const out = await svc.syncList('u1');
  assert.equal(out.synced, 3);
  assert.equal(out.matched, 1); // only 16498 has a local id_mal
  assert.equal(repo.entries.length, 3);
  assert.equal(repo.entries[0].animeId, 1);
  assert.equal(repo.entries[1].animeId, null);
});

test('updateEntry PATCHes MAL with the right form fields and stores locally', async () => {
  const repo = makeRepo();
  const { http, calls } = makeMalHttp();
  const svc = makeService(repo, http);
  const out = await svc.updateEntry('u1', 16498, { status: 'completed', score: 10, episodesWatched: 25 });
  const patch = calls.find((c) => c.url.includes('/anime/16498/my_list_status'));
  assert.ok(patch, 'PATCH must be sent');
  const body = new URLSearchParams(patch.body);
  assert.equal(body.get('status'), 'completed');
  assert.equal(body.get('score'), '10');
  assert.equal(body.get('num_watched_episodes'), '25');
  assert.equal(out.entry.animeId, 1);
});

test('removeEntry deletes from MAL and locally', async () => {
  const repo = makeRepo();
  const { http, calls } = makeMalHttp();
  const out = await makeService(repo, http).removeEntry('u1', 16498);
  assert.equal(out.success, true);
  assert.ok(calls.some((c) => c.url.includes('/anime/16498/my_list_status') && c.method === 'DELETE'));
});

test('updateProgress no-ops when the anime is not on the MAL list', async () => {
  const repo = makeRepo({ findEntryByAnimeId: async () => null });
  const out = await makeService(repo, makeMalHttp().http).updateProgress('u1', 999, 3);
  assert.deepEqual(out, { updated: false, reason: 'not_on_mal_list' });
});

test('updateProgress pushes episodes watched when the entry exists', async () => {
  const repo = makeRepo();
  repo.entries.push({ animeId: 1, malAnimeId: 16498, episodesWatched: 3 });
  const { http, calls } = makeMalHttp();
  const out = await makeService(repo, http).updateProgress('u1', 1, 5);
  assert.equal(out.updated, true);
  const patch = calls.find((c) => c.url.includes('/anime/16498/my_list_status'));
  assert.equal(new URLSearchParams(patch.body).get('num_watched_episodes'), '5');
});

test('lazy refresh: expired access token triggers a refresh before the call', async () => {
  const repo = makeRepo();
  repo.account.tokenExpiresAt = new Date(Date.now() - 1000); // expired
  const { http, calls } = makeMalHttp();
  const svc = makeService(repo, http);
  const token = await svc.ensureAccessToken('u1');
  assert.equal(token, 'at-refreshed');
  assert.equal(decryptSecret(repo.account.refreshTokenEnc), 'rt-refreshed');
  assert.ok(calls.some((c) => c.url.includes('/v1/oauth2/token')));
});

test('dead refresh token yields a 401 (reconnect), not a crash', async () => {
  const repo = makeRepo();
  repo.account.tokenExpiresAt = new Date(Date.now() - 1000);
  const svc = makeService(repo, makeMalHttp({ refreshToken: 'different' }).http);
  await assert.rejects(() => svc.ensureAccessToken('u1'), (err) => err.status === 401);
});

test('ensureAccessToken 401s when no account is linked', async () => {
  const repo = makeRepo({ findAccountByUser: async () => null });
  await assert.rejects(() => makeService(repo, makeMalHttp().http).ensureAccessToken('u1'), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test('disconnect clears the account', async () => {
  const repo = makeRepo();
  const out = await makeService(repo, makeMalHttp().http).disconnect('u1');
  assert.equal(out.success, true);
});
