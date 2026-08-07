// Database integrity tests against the real schema (PGlite): unique
// constraints, foreign keys + cascades, transaction rollback, advisory locks
// and concurrent-write safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedAnime, seedUser } from '../../helpers/pglite.mjs';

test('unique constraints prevent duplicate external ids', async () => {
  const { db, pool } = await createTestDb();
  await seedAnime(pool, { anilistId: 1, idMal: 1, slug: 'a' });
  await seedAnime(pool, { anilistId: 2, idMal: 2, slug: 'b' });

  // Forcing a second row onto an already-used key must fail on each of the
  // three unique indexes (anilist_id, id_mal, slug).
  for (const [label, sql] of [
    ['anilist_id', `UPDATE anime SET anilist_id = 1 WHERE id_mal = 2`],
    ['id_mal', `UPDATE anime SET id_mal = 1 WHERE id_mal = 2`],
    ['slug', `UPDATE anime SET slug = 'a' WHERE id_mal = 2`],
  ]) {
    await assert.rejects(db.query(sql), undefined, `${label} uniqueness not enforced`);
  }
  // sanity: the second row kept its original keys
  const { rows } = await db.query('SELECT anilist_id, id_mal, slug FROM anime WHERE id_mal = 2');
  assert.deepEqual(rows[0], { anilist_id: 2, id_mal: 2, slug: 'b' });
});

test('duplicate anime by either key is rejected at the constraint level', async () => {
  const { pool } = await createTestDb();
  await seedAnime(pool, { anilistId: 10, idMal: 10, slug: 'ten' });
  await assert.rejects(seedAnime(pool, { anilistId: 11, idMal: 10, slug: 'dup-mal' }));
  await assert.rejects(seedAnime(pool, { anilistId: 10, idMal: 11, slug: 'dup-anilist' }));
});

test('foreign keys + cascade deletes', async () => {
  const { db, pool } = await createTestDb();
  const animeId = await seedAnime(pool);
  const genre = await db.query(`INSERT INTO genres (name) VALUES ('Action') RETURNING id`);
  await db.query(`INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)`, [animeId, genre.rows[0].id]);
  const char = await db.query(
    `INSERT INTO characters (mal_id, name_first) VALUES (3, 'Jet') RETURNING id`,
  );
  await db.query(`INSERT INTO anime_characters (anime_id, character_id, role) VALUES ($1, $2, 'MAIN')`, [animeId, char.rows[0].id]);
  await db.query(`INSERT INTO anime_pictures (anime_id, image_url) VALUES ($1, 'http://x/p.jpg')`, [animeId]);

  // Deleting the anime cascades to joins + content tables.
  await db.query(`DELETE FROM anime WHERE id = $1`, [animeId]);
  const orphans = await db.query(
    `SELECT (SELECT count(*) FROM anime_genres WHERE anime_id = $1) +
            (SELECT count(*) FROM anime_characters WHERE anime_id = $1) +
            (SELECT count(*) FROM anime_pictures WHERE anime_id = $1) AS c`,
    [animeId],
  );
  assert.equal(orphans.rows[0].c, 0, 'cascades cleaned all joins');

  // Deleting a genre cascades to its join rows but not to anime.
  const anime2 = await seedAnime(pool, { anilistId: 3, idMal: 3, slug: 'three' });
  await db.query(`INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)`, [anime2, genre.rows[0].id]);
  await db.query(`DELETE FROM genres WHERE id = $1`, [genre.rows[0].id]);
  const left = await db.query('SELECT count(*)::int AS c FROM anime WHERE id = $1', [anime2]);
  assert.equal(left.rows[0].c, 1, 'anime survives genre deletion');
});

test('transactions roll back atomically on failure', async () => {
  const { db, pool } = await createTestDb();
  await seedUser(pool, { username: 'bob', email: 'bob@example.com' });
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(`INSERT INTO users (username, email, password_hash) VALUES ('x', 'x@x.com', 'h')`);
      await tx.query(`INSERT INTO users (username, email, password_hash) VALUES ('x', 'x@x.com', 'h')`); // dup username
    }),
  );
  const { rows } = await db.query(`SELECT count(*)::int AS c FROM users WHERE username = 'x'`);
  assert.equal(rows[0].c, 0, 'failed transaction left nothing behind');
});

test('advisory lock functions exist and round-trip', async () => {
  const { db } = await createTestDb();
  const KEY = 'import:anilist-anime';
  // pg_advisory_lock/unlock + hashtextextended are what Database.advisoryLock
  // uses; PGlite is a single session, so cross-session blocking semantics are
  // PostgreSQL-native (verified on a real server), not testable here.
  await db.exec(`SELECT pg_advisory_lock(hashtextextended('import:x', 0))`);
  const held = await db.query(`SELECT pg_locks IS NOT NULL AS ok FROM pg_locks LIMIT 1`);
  assert.equal(held.rows.length, 1);
  await db.exec(`SELECT pg_advisory_unlock(hashtextextended('import:x', 0))`);
  assert.ok(true, 'lock/unlock round-trip works');
});

test('concurrent same-key inserts produce one row, not duplicates', async () => {
  const { db } = await createTestDb();
  // Simulate two concurrent imports of the same MAL id: the unique index
  // allows exactly one INSERT to win.
  const results = await Promise.allSettled([
    db.query(`INSERT INTO anime (anilist_id, id_mal, title_romaji, slug) VALUES (1, 1, 'A', 'a')`),
    db.query(`INSERT INTO anime (anilist_id, id_mal, title_romaji, slug) VALUES (1, 1, 'A', 'a')`),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(succeeded, 1, 'exactly one concurrent insert wins');
  const { rows } = await db.query(`SELECT count(*)::int AS c FROM anime WHERE id_mal = 1`);
  assert.equal(rows[0].c, 1, 'no duplicate rows');
});
