// anime.repository tests against the real schema (PGlite): listing with
// filters/sort whitelist/pagination, detail + 404, search, genre/studio
// grouping, characters, episodes and rating stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedAnime, seedUser } from '../../helpers/pglite.mjs';
import { createAnimeRepository } from '../../../src/modules/anime/anime.repository.js';

async function setup() {
  const { pool } = await createTestDb();
  const repo = createAnimeRepository(pool);
  const bebop = await seedAnime(pool, {
    anilistId: 1, idMal: 1, slug: 'cowboy-bebop', titleRomaji: 'Cowboy Bebop',
    season: 'SPRING', seasonYear: 1998, averageScore: 86, popularity: 500_000,
  });
  const champloo = await seedAnime(pool, {
    anilistId: 2, idMal: 2, slug: 'samurai-champloo', titleRomaji: 'Samurai Champloo',
    titleNative: 'サムライチャンプルー', titleEnglish: 'Samurai Champloo',
    season: 'SUMMER', seasonYear: 2004, averageScore: 84, popularity: 400_000,
  });
  const adult = await seedAnime(pool, {
    anilistId: 3, idMal: 3, slug: 'adult-only', titleRomaji: 'Kite', titleEnglish: 'Kite', season: 'FALL',
    seasonYear: 1998, averageScore: 70, popularity: 50_000, isAdult: true,
  });
  const genre = await pool.query(`INSERT INTO genres (name) VALUES ('Action') RETURNING id`);
  const studio = await pool.query(`INSERT INTO studios (name) VALUES ('Sunrise') RETURNING id`);
  await pool.query(`INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)`, [bebop, genre.rows[0].id]);
  await pool.query(`INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)`, [champloo, genre.rows[0].id]);
  await pool.query(`INSERT INTO anime_studios (anime_id, studio_id, is_main) VALUES ($1, $2, true)`, [bebop, studio.rows[0].id]);
  await pool.query(
    `INSERT INTO episodes (anime_id, number, anilist_id, title) VALUES ($1, 1, 100, 'Asteroid Blues'), ($1, 2, 101, 'Stray Dog Strut')`,
    [bebop],
  );
  return { pool, repo, bebop, champloo, adult, genreId: genre.rows[0].id, studioId: studio.rows[0].id };
}

test('listAnime: pagination, ordering and adult filtering', async () => {
  const { repo, adult } = await setup();
  const all = await repo.listAnime({ limit: 10, offset: 0 });
  assert.equal(all.total, 2, 'adult titles hidden by default');
  assert.equal(all.items.length, 2);

  const withAdult = await repo.listAnime({ includeAdult: true, limit: 10, offset: 0 });
  assert.equal(withAdult.total, 3);

  // sort whitelist: unknown sort falls back to popularity_desc
  const sorted = await repo.listAnime({ includeAdult: true, sort: 'popularity_asc', limit: 10, offset: 0 });
  assert.equal(sorted.items[0].id, adult, 'least popular first');
  const bad = await repo.listAnime({ includeAdult: true, sort: 'bogus; DROP TABLE anime', limit: 10, offset: 0 });
  assert.equal(bad.total, 3, 'invalid sort cannot inject SQL');

  // filters
  const filtered = await repo.listAnime({ includeAdult: true, season: 'SPRING', year: 1998, limit: 10, offset: 0 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].titleRomaji, 'Cowboy Bebop');

  // pagination: offset skips
  const page2 = await repo.listAnime({ includeAdult: true, limit: 1, offset: 1 });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.total, 3);
});

test('detail: findAnimeById returns the joined row or null; anilist id lookup', async () => {
  const { repo, bebop, champloo } = await setup();
  const detail = await repo.findAnimeById(bebop);
  assert.equal(detail.id, bebop);
  assert.equal(detail.titleRomaji, 'Cowboy Bebop');
  assert.equal(detail.genres[0].name, 'Action');
  assert.equal(detail.synopsis, 'Space jazz.');
  const studios = await repo.findStudiosByAnimeId(bebop);
  assert.equal(studios[0].name, 'Sunrise');
  assert.equal(studios[0].isMain, true);
  assert.equal(await repo.findAnimeById(999_999), null);
  assert.equal(await repo.animeExists(bebop), true);
  assert.equal(await repo.animeExists(999_999), false);
  assert.equal(await repo.findAnilistId(champloo), 2);
});

test('search finds by romaji/english/native and is injection-safe', async () => {
  const { repo } = await setup();
  const byRomaji = await repo.searchAnime({ q: 'cowboy', limit: 10, offset: 0 });
  assert.equal(byRomaji.total, 1);
  assert.equal(byRomaji.items[0].titleRomaji, 'Cowboy Bebop');

  const byNative = await repo.searchAnime({ q: 'サムライ', limit: 10, offset: 0 });
  assert.equal(byNative.total, 1, 'native title search works');
  assert.equal(byNative.items[0].titleRomaji, 'Samurai Champloo');

  const empty = await repo.searchAnime({ q: 'zzz-no-such', limit: 10, offset: 0 });
  assert.equal(empty.total, 0);

  const injected = await repo.searchAnime({ q: "'; DROP TABLE anime; --", limit: 10, offset: 0 });
  assert.equal(injected.total, 0, 'injection payload cannot drop anything');
});

test('genre + studio grouping: findById, listByGenre, listByStudio', async () => {
  const { repo, genreId, studioId, bebop, champloo } = await setup();
  assert.equal((await repo.findGenreById(genreId)).name, 'Action');
  assert.equal(await repo.findGenreById(999_999), null);
  assert.equal((await repo.findStudioById(studioId)).name, 'Sunrise');

  const genreList = await repo.listByGenre(genreId, { limit: 10, offset: 0 });
  assert.equal(genreList.total, 2);
  assert.deepEqual(genreList.items.map((a) => a.id).sort(), [bebop, champloo].sort());

  const studioList = await repo.listByStudio(studioId, { limit: 10, offset: 0 });
  assert.equal(studioList.total, 1);
  assert.equal(studioList.items[0].id, bebop);
});

test('characters, episodes and rating stats', async () => {
  const { pool, repo, bebop } = await setup();
  await seedUser(pool, { username: 'critic', email: 'critic@example.com' });
  const c = await pool.query(`INSERT INTO characters (mal_id, name_first) VALUES (3, 'Jet') RETURNING id`);
  await pool.query(`INSERT INTO anime_characters (anime_id, character_id, role) VALUES ($1, $2, 'MAIN')`, [bebop, c.rows[0].id]);
  await pool.query(`INSERT INTO ratings (anime_id, user_id, score) VALUES ($1, (SELECT id FROM users LIMIT 1), 9)`, [bebop]);

  const chars = await repo.findCharactersByAnimeId(bebop);
  assert.equal(chars.length, 1);
  assert.equal(chars[0].nameFirst, 'Jet');
  assert.equal(chars[0].role, 'MAIN');

  const eps = await repo.listEpisodesByAnime(bebop, { limit: 10, offset: 0 });
  assert.equal(eps.total, 2);
  assert.equal(eps.items[0].number, 1);

  const stats = await repo.findRatingStats(bebop);
  assert.equal(stats.count, 1);
  assert.equal(stats.average, 9);
  assert.equal(await repo.countEpisodes(bebop), 2);
});
