import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUserService } from '../../../src/modules/user/user.service.js';
import { ApiError } from '../../../src/lib/errors.js';

function makeService(overrides = {}) {
  const repository = {
    findPublicById: async () => ({ id: 'u1', username: 'tester' }),
    findEpisodeIdByAnimeAndNumber: async () => 42,
    touchHistory: async (userId, episodeId, fields) => ({ id: 1, episodeId, ...fields }),
    listContinueWatching: async () => ({ items: [{ animeId: 7 }], total: 1 }),
    upsertContinueWatching: async (userId, fields) => ({ ...fields, updatedAt: 'now' }),
    deleteContinueWatching: async () => 1,
    deleteFavorite: async () => 1,
    ...overrides,
  };
  return createUserService({ repository });
}

test('addHistory resolves the episode and touches history once', async () => {
  const calls = [];
  const svc = makeService({
    findEpisodeIdByAnimeAndNumber: async (animeId, episode) => { calls.push([animeId, episode]); return 42; },
    touchHistory: async (userId, episodeId) => ({ id: 9, episodeId }),
  });
  const out = await svc.addHistory('u1', { animeId: 7, episode: 3 });
  assert.deepEqual(calls, [[7, 3]]);
  assert.deepEqual(out.history, { id: 9, episodeId: 42 });
});

test('addHistory 404s when the episode does not exist', async () => {
  const svc = makeService({ findEpisodeIdByAnimeAndNumber: async () => null });
  await assert.rejects(() => svc.addHistory('u1', { animeId: 7, episode: 99 }), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('saveContinueWatching upserts progress', async () => {
  const svc = makeService();
  const out = await svc.saveContinueWatching('u1', 7, {
    episodeNumber: 2,
    playbackPositionSeconds: 150,
    durationSeconds: 1440,
  });
  assert.equal(out.episodeNumber, 2);
  assert.equal(out.playbackPositionSeconds, 150);
});

test('saveContinueWatching removes the entry when the episode is finished', async () => {
  let deleted = false;
  const svc = makeService({
    deleteContinueWatching: async () => { deleted = true; return 1; },
    upsertContinueWatching: async () => { throw new Error('must not upsert after completion'); },
  });
  const out = await svc.saveContinueWatching('u1', 7, {
    episodeNumber: 1,
    playbackPositionSeconds: 1437, // within 5s of the end
    durationSeconds: 1440,
  });
  assert.equal(out.completed, true);
  assert.equal(out.removed, true);
  assert.equal(deleted, true);
});

test('listContinueWatching is paginated', async () => {
  const svc = makeService();
  const out = await svc.listContinueWatching('u1', { page: 1, limit: 20 });
  assert.equal(out.data.length, 1);
  assert.equal(out.meta.total, 1);
  assert.equal(out.meta.page, 1);
});

test('removeContinueWatching 404s when nothing to remove', async () => {
  const svc = makeService({ deleteContinueWatching: async () => 0 });
  await assert.rejects(() => svc.removeContinueWatching('u1', 7), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('removeFavorite passes through to the repository delete', async () => {
  const calls = [];
  const svc = makeService({
    deleteFavorite: async (userId, id) => { calls.push([userId, id]); return 1; },
  });
  const out = await svc.removeFavorite('u1', 123);
  assert.deepEqual(calls, [['u1', 123]]);
  assert.deepEqual(out, { success: true });
});

test('getProfile surfaces unknown users as 404', async () => {
  const svc = makeService({ findPublicById: async () => null });
  await assert.rejects(() => svc.getProfile('missing'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    return true;
  });
});
