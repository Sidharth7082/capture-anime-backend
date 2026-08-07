// mal.repository tests against the real schema (PGlite): pending OAuth
// (consume-once), account token storage, and list sync (upsert / prune).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedAnime, seedUser } from '../../helpers/pglite.mjs';
import { createMalRepository } from '../../../src/modules/mal/mal.repository.js';

async function setup() {
  const { pool } = await createTestDb();
  const repo = createMalRepository(pool);
  const userId = await seedUser(pool);
  const animeId = await seedAnime(pool, { anilistId: 1, idMal: 1, slug: 'a' });
  return { pool, repo, userId, animeId };
}

test('pending OAuth: insert, consume once, reject expired/unknown states', async () => {
  const { repo, userId } = await setup();
  await repo.insertPending({ state: 's1', codeVerifier: 'verifier', userId, expiresAt: new Date(Date.now() + 60_000) });

  const first = await repo.consumePending('s1');
  assert.deepEqual(first, { codeVerifier: 'verifier', userId }, 'consumed atomically');
  // consume-once: the row is DELETEd, so a second call gets nothing.
  assert.equal(await repo.consumePending('s1'), null);
  assert.equal(await repo.consumePending('unknown-state'), null);

  // expired state is never consumable
  await repo.insertPending({ state: 'expired', codeVerifier: 'v', userId, expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await repo.consumePending('expired'), null);
});

test('account: upsert, find, delete', async () => {
  const { repo, userId } = await setup();
  await repo.upsertAccount({
    userId,
    malId: 123,
    malUsername: 'alice_mal',
    accessTokenEnc: 'enc-access',
    refreshTokenEnc: 'enc-refresh',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    scopes: 'my_list:read',
  });
  const acc = await repo.findAccountByUser(userId);
  assert.equal(acc.malId, 123);
  assert.equal(acc.accessTokenEnc, 'enc-access');
  assert.equal(acc.malUsername, 'alice_mal');

  // re-upsert updates in place (single row)
  await repo.upsertAccount({
    userId,
    malId: 123,
    malUsername: 'alice_mal',
    accessTokenEnc: 'enc-2',
    refreshTokenEnc: 'r',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    scopes: 'my_list:read',
  });
  const again = await repo.findAccountByUser(userId);
  assert.equal(again.accessTokenEnc, 'enc-2');

  await repo.deleteAccount(userId);
  assert.equal(await repo.findAccountByUser(userId), null);
});

test('entries: upsert by mal id, list + status filter, prune-on-full-sync', async () => {
  const { repo, userId, animeId } = await setup();
  await repo.upsertEntry(userId, { malAnimeId: 1, animeId, status: 'watching', score: 8, episodesWatched: 3, isRewatching: false, rewatchCount: 0, updatedAt: new Date() });
  await repo.upsertEntry(userId, { malAnimeId: 1, animeId, status: 'completed', score: 9, episodesWatched: 26, isRewatching: false, rewatchCount: 0, updatedAt: new Date() });
  // upsert by (user, mal_anime_id): still one row
  const found = await repo.findEntry(userId, 1);
  assert.equal(found.status, 'completed');
  assert.equal(found.score, 9);

  // second anime entry for the filter test
  await repo.upsertEntry(userId, { malAnimeId: 2, animeId, status: 'plan_to_watch', score: 0, episodesWatched: 0, isRewatching: false, rewatchCount: 0, updatedAt: new Date() });

  const all = await repo.listEntries(userId, { limit: 20, offset: 0 });
  assert.equal(all.total, 2);
  const watching = await repo.listEntries(userId, { status: 'plan_to_watch', limit: 20, offset: 0 });
  assert.equal(watching.total, 1);

  // local-anime lookup for the player progress push
  assert.equal((await repo.findEntryByAnimeId(userId, animeId)).malAnimeId, 1);

  // full sync prunes rows no longer on the MAL list
  await repo.deleteEntriesExcept(userId, [1]);
  const after = await repo.listEntries(userId, { limit: 20, offset: 0 });
  assert.equal(after.total, 1, 'entries not on the list are removed');

  assert.equal(await repo.deleteEntry(userId, 1), 1);
});

test('findAnimeIdByMalId resolves or nulls', async () => {
  const { repo, animeId } = await setup();
  assert.equal(await repo.findAnimeIdByMalId(1), animeId);
  assert.equal(await repo.findAnimeIdByMalId(999_999), null);
});
