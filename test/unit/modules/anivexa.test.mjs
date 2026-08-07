import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnivexaService } from '../../../src/services/anivexa.js';
import { ApiError } from '../../../src/lib/errors.js';

const EPISODES_BODY = {
  type: 'filtered',
  mappings: { id: 16498 },
  reanime: {
    meta: { title: 'Attack on Titan', slug: 'x', malId: 16498, source: 'reanime' },
    episodes: {
      sub: [
        { id: 'watch/reanime/16498/sub/reanime-1', number: 1, title: 'To You', audio: 'sub' },
        { id: 'watch/reanime/16498/sub/reanime-2', number: 2, title: 'Day', audio: 'sub' },
      ],
      dub: [{ id: 'watch/reanime/16498/dub/reanime-1', number: 1, title: 'To You', audio: 'dub' }],
    },
  },
  anikoto: {
    meta: { title: 'Attack on Titan', slug: 'y', malId: 16498, source: 'anikoto' },
    episodes: {
      sub: [{ id: 'watch/anikoto/16498/sub/anikoto-1', number: 1, title: 'To You', audio: 'sub' }],
      dub: [],
    },
  },
  animenosub: { error: 'provider down', stack: 'x' }, // error slot must be skipped
};

const WATCH_BODY = {
  anilistId: 16498,
  malId: 16498,
  episode: 1,
  audio: 'sub',
  streams: [
    {
      url: 'https://cdn.example/master.m3u8',
      type: 'hls',
      server: 'HD-1',
      subtitles: [{ url: 'https://cdn.example/en.vtt', label: 'English', srclang: 'en', default: true }],
    },
    { url: 'https://cdn.example/720.mp4', type: 'mp4', server: 'HD-2' },
  ],
  subtitles: [{ url: 'https://cdn.example/en.vtt', label: 'English', srclang: 'en', default: true }],
};

function makeService({ fetchJson, baseUrl = 'http://anivexa.test', providers } = {}) {
  return new AnivexaService({
    baseUrl,
    providers: providers ?? ['reanime', 'anikoto'],
    fetchJson,
    maxParallel: 3,
  });
}

test('getEpisodes keeps provider slots and drops error/empty ones', async () => {
  const svc = makeService({ fetchJson: async () => EPISODES_BODY });
  const result = await svc.getEpisodes(16498);
  assert.deepEqual(Object.keys(result), ['reanime', 'anikoto']);
  assert.equal(result.reanime.sub.length, 2);
  assert.equal(result.reanime.dub.length, 1);
});

test('getEpisodes throws STREAM_UNAVAILABLE when no provider has episodes', async () => {
  const svc = makeService({ fetchJson: async () => ({ type: 'filtered', animenosub: { error: 'x' } }) });
  await assert.rejects(() => svc.getEpisodes(999), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'STREAM_UNAVAILABLE');
    return true;
  });
});

test('getWatch returns the normalized response shape', async () => {
  const calls = [];
  const svc = makeService({
    fetchJson: async (path) => {
      calls.push(path);
      return WATCH_BODY;
    },
  });
  const out = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.deepEqual(Object.keys(out).sort(), ['audio', 'episode', 'provider', 'servers', 'streams', 'subtitles']);
  assert.equal(out.provider, 'reanime');
  assert.equal(out.episode, 1);
  assert.equal(out.audio, 'sub');
  assert.equal(out.streams.length, 2);
  assert.deepEqual(out.servers, ['HD-1', 'HD-2']);
  assert.equal(out.subtitles.length, 1);
  // direct-path construction — no episode-list round trip on the hot path
  assert.ok(calls.includes('/watch/reanime/16498/sub/reanime-1'));
  assert.ok(!calls.some((c) => c.startsWith('/episodes/')));
});

test('getWatch fails over to the next provider when the first errors', async () => {
  const svc = makeService({
    fetchJson: async (path) => {
      if (path.includes('/reanime/')) throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'upstream 500');
      return WATCH_BODY; // anikoto succeeds
    },
  });
  const out = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(out.provider, 'anikoto');
});

test('getWatch throws 502 when every provider fails upstream', async () => {
  const svc = makeService({
    fetchJson: async () => { throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'boom'); },
  });
  await assert.rejects(() => svc.getWatch(16498, 99, { audio: 'sub' }), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'ANIVEXA_UNAVAILABLE');
    return true;
  });
});

test('getWatch caches a successful response (second call served from cache)', async () => {
  let upstream = 0;
  const svc = makeService({
    fetchJson: async (path) => { upstream++; return WATCH_BODY; },
  });
  await svc.getWatch(16498, 1, { audio: 'sub' });
  const first = upstream;
  await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(upstream, first, 'second call should come from cache');
});

test('getWatch serves stale result (SWR) and refreshes in the background', async () => {
  let upstream = 0;
  let serve = true;
  const svc = makeService({
    fetchJson: async (path) => {
      upstream++;
      if (!serve) throw new Error('refreshed');
      return WATCH_BODY;
    },
  });
  const first = await svc.getWatch(16498, 1, { audio: 'sub' });
  const probesFirst = upstream; // parallel probes (≥1 upstream calls)
  // Force-expire every fresh entry in the TTL cache.
  for (const k of svc.cache.map.keys()) svc.cache.map.get(k).expiresAt = Date.now() - 1;
  serve = false; // the background refresh will fail — that must not reject the caller
  const second = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(second.provider, first.provider, 'stale value served immediately');
  const probesSecond = upstream;
  // SWR triggers a background refresh (extra upstream call) instead of a
  // blocking re-resolve.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(upstream > probesSecond, 'background refresh was attempted after SWR');
  assert.ok(upstream - probesSecond < probesFirst + 5, 'refresh is bounded (no fan-out)');
});

test('providers are ranked fastest-first after measuring latency', async () => {
  let calls = 0;
  const svc = makeService({
    fetchJson: async (path) => {
      calls++;
      await new Promise((r) => setTimeout(r, path.includes('/reanime/') ? 5 : 40));
      return WATCH_BODY;
    },
  });
  const first = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(first.provider, 'reanime', 'first probe returns reanime (faster)');
  // reanime measured ~5ms, anikoto ~40ms → reanime stays first
  assert.equal(svc.orderedProviders()[0], 'reanime');
  const second = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(second.provider, 'reanime');
  void calls;
});

test('prefetch warms the cache for the first episodes', async () => {
  let watchCalls = 0;
  const svc = makeService({
    fetchJson: async (path) => {
      if (path.startsWith('/episodes/')) return EPISODES_BODY;
      watchCalls++;
      return WATCH_BODY;
    },
  });
  const result = await svc.prefetch(16498, 2);
  assert.equal(result.prefetched, 2);
  // wait for background warmers
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(watchCalls >= 2, 'watch endpoints warmed for prefetched episodes');
  // subsequent auto getWatch hits the warmed cache
  const upstreamBefore = watchCalls;
  const out = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(out.provider, 'reanime');
  assert.equal(watchCalls, upstreamBefore, 'prefetched episode served from cache');
});

test('not configured yields 503 STREAMING_NOT_CONFIGURED', async () => {
  // baseUrl: '' (not undefined) so the constructor's env.ANIVEXA_API_URL
  // fallback can't accidentally configure the service from the developer's
  // .env — the test must be deterministic.
  const svc = new AnivexaService({ baseUrl: '', providers: ['reanime'] });
  await assert.rejects(() => svc.getWatch(1, 1), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, 'STREAMING_NOT_CONFIGURED');
    return true;
  });
});
