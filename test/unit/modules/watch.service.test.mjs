// watch.service tests: id resolution, 404 handling, provider fallback and
// prefetch delegation.
import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchService } from '../../../src/modules/watch/watch.service.js';

function makeDeps({ anilistId = 55, anivexaImpl = {} } = {}) {
  const anivexa = {
    getWatch: async (id, episode, opts) => ({ url: `http://stream/${id}/${episode}`, opts }),
    prefetch: async (id, count) => ({ prefetched: count, id }),
    ...anivexaImpl,
  };
  const animeRepository = {
    findAnilistId: async () => anilistId,
  };
  return { service: createWatchService({ animeRepository, anivexa }), anivexa, animeRepository };
}

test('watch resolves the anilist id and asks the provider', async () => {
  const { service, anivexa } = makeDeps();
  const result = await service.watch(7, 3, { provider: 'gogoanime', audio: 'japanese' });
  assert.equal(result.url, 'http://stream/55/3');
  assert.deepEqual(result.opts, { provider: 'gogoanime', audio: 'japanese' });
  void anivexa;
});

test('watch 404s when the anime is not in the catalog', async () => {
  const { service } = makeDeps({ anilistId: null });
  await assert.rejects(service.watch(999, 1), (err) => err.status === 404);
});

test('prefetch delegates the warm-up request', async () => {
  const { service, anivexa } = makeDeps();
  const result = await service.prefetch(7, 3);
  assert.deepEqual(result, { prefetched: 3, id: 55 });
});

test('provider errors propagate with status', async () => {
  const { service } = makeDeps({
    anivexaImpl: {
      getWatch: async () => {
        const err = new Error('provider down');
        err.status = 502;
        throw err;
      },
    },
  });
  await assert.rejects(service.watch(7, 1), (err) => err.status === 502);
});
