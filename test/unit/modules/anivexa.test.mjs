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

function makeService({ fetchJson, baseUrl = 'http://anivexa.test' } = {}) {
  return new AnivexaService({ baseUrl, providers: ['reanime', 'anikoto'], fetchJson });
}

test('getEpisodes keeps provider slots and drops error/empty ones', async () => {
  const svc = makeService({ fetchJson: async () => EPISODES_BODY });
  const result = await svc.getEpisodes(16498);
  assert.deepEqual(Object.keys(result), ['reanime', 'anikoto']);
  assert.equal(result.reanime.sub.length, 2);
  assert.equal(result.reanime.dub.length, 1);
  assert.equal(result.anikoto.sub[0].id, 'watch/anikoto/16498/sub/anikoto-1');
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
      if (path.startsWith('/episodes/')) return EPISODES_BODY;
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
  // resolves the exact watch path from the episode id
  assert.ok(calls.includes('/watch/reanime/16498/sub/reanime-1'));
});

test('getWatch fails over to the next provider when the first errors', async () => {
  const svc = makeService({
    fetchJson: async (path) => {
      if (path.startsWith('/episodes/')) return EPISODES_BODY;
      if (path === '/watch/reanime/16498/sub/reanime-1') {
        throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'upstream 500');
      }
      return WATCH_BODY; // anikoto watch succeeds
    },
  });
  const out = await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(out.provider, 'anikoto');
});

test('getWatch throws when every provider fails or lacks the episode', async () => {
  const svc = makeService({
    fetchJson: async (path) => {
      if (path.startsWith('/episodes/')) return EPISODES_BODY;
      throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'boom');
    },
  });
  await assert.rejects(() => svc.getWatch(16498, 99, { audio: 'sub' }), (err) => {
    assert.equal(err.status, 404); // episode 99 not in any provider list
    assert.equal(err.code, 'STREAM_UNAVAILABLE');
    return true;
  });
  await assert.rejects(() => svc.getWatch(16498, 1, { audio: 'sub' }), (err) => {
    assert.equal(err.status, 502); // episode 1 exists but every watch call fails
    assert.equal(err.code, 'ANIVEXA_UNAVAILABLE');
    return true;
  });
});

test('getWatch caches a successful response', async () => {
  let upstream = 0;
  const svc = makeService({
    fetchJson: async (path) => {
      if (path.startsWith('/episodes/')) { upstream++; return EPISODES_BODY; }
      upstream++;
      return WATCH_BODY;
    },
  });
  await svc.getWatch(16498, 1, { audio: 'sub' });
  const first = upstream;
  await svc.getWatch(16498, 1, { audio: 'sub' });
  assert.equal(upstream, first, 'second call should come from cache');
});

test('not configured yields 503 STREAMING_NOT_CONFIGURED', async () => {
  const svc = new AnivexaService({ baseUrl: undefined, providers: ['reanime'] });
  await assert.rejects(() => svc.getWatch(1, 1), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, 'STREAMING_NOT_CONFIGURED');
    return true;
  });
});
