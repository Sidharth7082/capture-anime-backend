import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnimeService } from '../../../src/modules/anime/anime.service.js';
import { ApiError } from '../../../src/lib/errors.js';

function makeFakeRepository() {
  const repo = {
    calls: [],
    async listAnime({ status, format, season, year, includeAdult, sort, limit, offset }) {
      repo.calls.push({ method: 'listAnime', status, format, season, year, includeAdult, sort, limit, offset });
      return { items: [{ id: 1, titleRomaji: 'X' }], total: 42 };
    },
    async findAnimeById(id) {
      return id === 1 ? { id: 1, titleRomaji: 'X' } : null;
    },
    async findGenresByAnimeId() { return [{ id: 1, name: 'Action' }]; },
    async findStudiosByAnimeId() { return []; },
    async findCharactersByAnimeId() { return []; },
    async findRatingStats() { return { count: 3, average: 8.5 }; },
    async countEpisodes() { return 25; },
    async animeExists(id) { return id === 1; },
    async searchAnime({ q, limit, offset }) {
      repo.calls.push({ method: 'searchAnime', q, limit, offset });
      return { items: [{ id: 1 }], total: 1 };
    },
    async findGenreById(id) { return id === 5 ? { id: 5, name: 'Action' } : null; },
    async listByGenre() { return { items: [], total: 0 }; },
    async findStudioById(id) { return id === 6 ? { id: 6, name: 'MAPPA' } : null; },
    async listByStudio() { return { items: [], total: 0 }; },
    async listEpisodesByAnime() { return { items: [{ id: 1, number: 1 }], total: 25 }; },
  };
  return repo;
}

test('list returns data + pagination meta and passes filters', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });

  const result = await service.list({
    page: 2,
    limit: 10,
    status: 'RELEASING',
    season: 'WINTER',
    year: 2024,
    sort: 'score_desc',
    includeAdult: true,
  });

  assert.equal(result.data.length, 1);
  assert.equal(result.meta.total, 42);
  assert.equal(result.meta.page, 2);
  assert.equal(result.meta.limit, 10);

  const call = repo.calls[0];
  assert.equal(call.status, 'RELEASING');
  assert.equal(call.season, 'WINTER');
  assert.equal(call.year, 2024);
  assert.equal(call.sort, 'score_desc');
  assert.equal(call.includeAdult, true);
  assert.equal(call.offset, 10);
});

test('list defaults to popularity_desc and excludes adult', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  await service.list({});
  const call = repo.calls[0];
  assert.equal(call.sort, 'popularity_desc');
  assert.equal(call.includeAdult, undefined); // repository applies is_adult = FALSE
});

test('getById assembles detail or 404s', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });

  const detail = await service.getById(1);
  assert.equal(detail.genres[0].name, 'Action');
  assert.equal(detail.episodeCount, 25);
  assert.equal(detail.rating.average, 8.5);

  await assert.rejects(service.getById(999), (err) => err instanceof ApiError && err.status === 404);
});

test('trending / popular / recent force their sort', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  await service.trending({});
  await service.popular({});
  await service.recent({});
  assert.equal(repo.calls[0].sort, 'popularity_desc');
  assert.equal(repo.calls[1].sort, 'score_desc');
  assert.equal(repo.calls[2].sort, 'recent_desc');
});

test('byGenre 404s for unknown genre', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  await assert.rejects(service.byGenre(999, {}), (err) => err.status === 404);
});

test('byGenre returns genre context for known genre', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  const result = await service.byGenre(5, {});
  assert.equal(result.genre.name, 'Action');
  assert.ok(result.meta);
});

test('byStudio 404s for unknown studio', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  await assert.rejects(service.byStudio(999, {}), (err) => err.status === 404);
});

test('episodes 404s for unknown anime, returns list otherwise', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  await assert.rejects(service.episodes(999, {}), (err) => err.status === 404);
  const result = await service.episodes(1, {});
  assert.equal(result.animeId, 1);
  assert.equal(result.data[0].number, 1);
});

test('search passes the query through', async () => {
  const repo = makeFakeRepository();
  const service = createAnimeService({ repository: repo });
  const result = await service.search({ q: 'shingeki', page: '1', limit: '5' });
  assert.equal(result.meta.total, 1);
  assert.equal(repo.calls.find((c) => c.method === 'searchAnime').q, 'shingeki');
});
