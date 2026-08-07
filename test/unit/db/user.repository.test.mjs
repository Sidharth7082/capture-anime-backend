// user.repository tests against the real schema (PGlite): favorites
// (dedupe + type detection), watch history (once-per-episode semantics) and
// continue-watching (upsert + auto-complete removal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedAnime, seedUser } from '../../helpers/pglite.mjs';
import { createUserRepository } from '../../../src/modules/user/user.repository.js';

async function setup() {
  const { pool } = await createTestDb();
  const repo = createUserRepository(pool);
  const userId = await seedUser(pool);
  const animeA = await seedAnime(pool, { anilistId: 1, idMal: 1, slug: 'a' });
  const animeB = await seedAnime(pool, { anilistId: 2, idMal: 2, slug: 'b' });
  return { pool, repo, userId, animeA, animeB };
}

test('favorites: add, dedupe, list with type detection, delete', async () => {
  const { pool, repo, userId, animeA, animeB } = await setup();

  const fav1 = await repo.addFavorite(userId, { animeId: animeA });
  const fav2 = await repo.addFavorite(userId, { animeId: animeB });
  assert.equal(typeof fav1.id, 'number');
  assert.equal(fav1.created, true);

  // Adding the same target again is a no-op (ON CONFLICT DO NOTHING).
  const dup = await repo.addFavorite(userId, { animeId: animeA });
  assert.equal(dup.created, false);

  const list = await repo.listFavorites(userId, { limit: 20, offset: 0 });
  assert.equal(list.total, 2, 'two distinct favorites');
  assert.deepEqual(
    list.items.map((f) => f.type),
    ['anime', 'anime'],
  );
  assert.equal(list.items[0].anime.title, 'Cowboy Bebop');

  // One favorite per target: finding by target must not duplicate.
  const found = await repo.findFavoriteByTarget(userId, { animeId: animeA });
  assert.equal(found.id, fav1.id);

  await repo.deleteFavorite(userId, fav2.id);
  const after = await repo.listFavorites(userId, { limit: 20, offset: 0 });
  assert.equal(after.total, 1);
});

test('watch history: touching the same episode never creates a duplicate row', async () => {
  const { pool, repo, userId, animeA } = await setup();
  await pool.query(
    `INSERT INTO episodes (anime_id, number, anilist_id) VALUES ($1, 1, 100) RETURNING id`,
    [animeA],
  );
  const episodeId = await repo.findEpisodeIdByAnimeAndNumber(animeA, 1);
  assert.ok(episodeId, 'episode resolved');

  await repo.touchHistory(userId, episodeId, { progressSeconds: 30, durationSeconds: 1440 });
  await repo.touchHistory(userId, episodeId, { progressSeconds: 60, durationSeconds: 1440, completed: true });
  await repo.touchHistory(userId, episodeId, { progressSeconds: 90 });

  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM watch_history WHERE user_id = $1 AND episode_id = $2`,
    [userId, episodeId],
  );
  assert.equal(rows[0].c, 1, 'exactly one row per (user, episode)');
  const { rows: h } = await pool.query(
    `SELECT progress_seconds, completed FROM watch_history WHERE user_id = $1 AND episode_id = $2`,
    [userId, episodeId],
  );
  assert.equal(h[0].progress_seconds, 90, 'progress merged, latest wins');
  assert.equal(h[0].completed, true, 'completed latches');

  const list = await repo.listHistory(userId, { limit: 20, offset: 0 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].animeId, animeA);
});

test('continue watching: upsert, list order, completion removal, delete', async () => {
  const { pool, repo, userId, animeA, animeB } = await setup();
  const { createUserService } = await import('../../../src/modules/user/user.service.js');
  const service = createUserService({ repository: repo });

  await repo.upsertContinueWatching(userId, { animeId: animeA, episodeNumber: 3, playbackPositionSeconds: 150, durationSeconds: 1440 });
  await repo.upsertContinueWatching(userId, { animeId: animeB, episodeNumber: 1, playbackPositionSeconds: 30, durationSeconds: 1440 });

  // same anime again -> single row, position updated
  await repo.upsertContinueWatching(userId, { animeId: animeA, episodeNumber: 3, playbackPositionSeconds: 600, durationSeconds: 1440 });

  const list = await repo.listContinueWatching(userId, { limit: 20, offset: 0 });
  assert.equal(list.total, 2, 'two resume points');
  assert.equal(list.items[0].animeId, animeA, 'newest update first');

  // completion removes the resume point (service: position within 5s of end)
  const nearEnd = await service.saveContinueWatching(userId, animeB, {
    episodeNumber: 1,
    playbackPositionSeconds: 1438,
    durationSeconds: 1440,
  });
  assert.deepEqual(nearEnd, { animeId: animeB, completed: true, removed: true });
  const after = await repo.listContinueWatching(userId, { limit: 20, offset: 0 });
  assert.equal(after.total, 1, 'completed entry removed');
  assert.equal(after.items[0].animeId, animeA);

  await repo.deleteContinueWatching(userId, animeA);
  const empty = await repo.listContinueWatching(userId, { limit: 20, offset: 0 });
  assert.equal(empty.total, 0);
});

test('profile lookup returns null for unknown users', async () => {
  const { repo } = await setup();
  assert.equal(await repo.findPublicById('00000000-0000-4000-8000-000000000000'), null);
});
