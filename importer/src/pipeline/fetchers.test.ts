/**
 * Unit tests for the enrichment fetcher: batching over the catalog, the six
 * detail endpoints per anime, per-endpoint failure isolation, pagination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJikanEnrichFetcher, type AnimeRowRef } from "./fetchers.js";

interface FakeJikan {
  getJsonCalls: Array<{ path: string }>;
  failEndpoints: Set<string>;
  getJson: <T>(path: string) => Promise<T>;
}

function makeFakeJikan(failEndpoints: string[] = []): FakeJikan {
  const calls: Array<{ path: string }> = [];
  const fail = new Set(failEndpoints);
  return {
    getJsonCalls: calls,
    failEndpoints: fail,
    async getJson<T>(path: string): Promise<T> {
      calls.push({ path });
      if (fail.has(path.split("/").pop()!)) throw new Error(`boom ${path}`);
      return { data: [] } as T;
    },
  };
}

const IDs: AnimeRowRef[] = [
  { id: 1, idMal: 1 },
  { id: 2, idMal: 2 },
  { id: 3, idMal: 3 },
];

test("enrich fetcher batches anime and queries six endpoints each", async () => {
  const jikan = makeFakeJikan();
  const f = createJikanEnrichFetcher({ jikan, listAnime: async () => IDs, batchSize: 2 });

  const page1 = await f.fetchPage(1);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasNextPage, true);
  assert.equal(page1.items[0]!.mal_id, 1);
  assert.equal(page1.items[1]!.mal_id, 2);
  assert.equal(jikan.getJsonCalls.length, 12); // 2 anime x 6 endpoints

  const page2 = await f.fetchPage(2);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.hasNextPage, false);
  assert.equal(page2.items[0]!.mal_id, 3);
  assert.equal(jikan.getJsonCalls.length, 18); // +6
});

test("endpoint failures are isolated into failedEndpoints, others still load", async () => {
  const jikan = makeFakeJikan(["staff", "pictures"]);
  const f = createJikanEnrichFetcher({ jikan, listAnime: async () => IDs.slice(0, 1), batchSize: 1 });

  const page = await f.fetchPage(1);
  const bundle = page.items[0]!;
  assert.deepEqual(bundle.failed_endpoints!.sort(), ["pictures", "staff"]);
  assert.deepEqual(bundle.characters, [], "characters endpoint succeeded (empty list)");
  assert.equal(bundle.staff, undefined, "failed endpoint contributes nothing");
  assert.equal(bundle.pictures, undefined, "failed endpoint contributes nothing");
});

test("no anime in the catalog means an empty last page", async () => {
  const jikan = makeFakeJikan();
  const f = createJikanEnrichFetcher({ jikan, listAnime: async () => [], batchSize: 10 });
  const page = await f.fetchPage(1);
  assert.equal(page.items.length, 0);
  assert.equal(page.hasNextPage, false);
  assert.equal(jikan.getJsonCalls.length, 0);
});
