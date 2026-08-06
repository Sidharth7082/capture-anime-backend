import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../../../src/lib/cache.js';

test('set/get roundtrip', () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  cache.set('a', { n: 1 });
  assert.deepEqual(cache.get('a'), { n: 1 });
});

test('expired entries are evicted on get', async () => {
  const cache = new TtlCache({ ttlMs: 20 });
  cache.set('a', 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cache.get('a'), undefined);
});

test('per-call ttl override', async () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  cache.set('a', 1, 10);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(cache.get('a'), undefined);
});

test('ttl 0 disables caching', () => {
  const cache = new TtlCache({ ttlMs: 0 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), undefined);
});

test('maxEntries evicts oldest', () => {
  const cache = new TtlCache({ ttlMs: 1000, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // evicts 'a'
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('del and clear', () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  cache.set('a', 1);
  cache.del('a');
  assert.equal(cache.get('a'), undefined);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
});
