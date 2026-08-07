/**
 * AniList fetcher tests: Page envelope handling + incremental cursor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAniListFetcher, ANILIST_PAGE_QUERY } from "./fetchers.js";

function fakeClient(pages: Array<{ hasNextPage: boolean; media: unknown[] }>) {
  const calls: Array<{ variables: Record<string, unknown> }> = [];
  return {
    calls,
    async query<T>(_query: string, variables: Record<string, unknown>): Promise<T> {
      calls.push({ variables });
      const page = pages[Number(variables.page) - 1] ?? { hasNextPage: false, media: [] };
      return { Page: { pageInfo: { hasNextPage: page.hasNextPage }, media: page.media } } as T;
    },
  };
}

test("fetcher paginates the Page envelope", async () => {
  const client = fakeClient([
    { hasNextPage: true, media: [{ id: 1 }] },
    { hasNextPage: false, media: [{ id: 2 }] },
  ]);
  const f = createAniListFetcher({ client: client as never, perPage: 50 });

  const p1 = await f.fetchPage(1);
  assert.equal(p1.items.length, 1);
  assert.equal(p1.hasNextPage, true);
  const p2 = await f.fetchPage(2);
  assert.equal(p2.items.length, 1);
  assert.equal(p2.hasNextPage, false);
  assert.equal(client.calls[0]!.variables.perPage, 50);
  assert.deepEqual(client.calls[0]!.variables.sort, ["ID"], "full sync sorts by ID");
});

test("incremental sync sorts by UPDATED_AT_DESC and stops at the stale boundary", async () => {
  const client = fakeClient([
    { hasNextPage: true, media: [{ id: 3, updatedAt: 1_700_000_100 }, { id: 2, updatedAt: 1_699_000_000 }] },
    { hasNextPage: false, media: [] },
  ]);
  const f = createAniListFetcher({ client: client as never, updatedAtGreater: 1_700_000_000 });
  const p1 = await f.fetchPage(1);
  assert.deepEqual(client.calls[0]!.variables.sort, ["UPDATED_AT_DESC"]);
  // item id 2 is stale (< cursor) -> excluded and pagination stops
  assert.deepEqual(p1.items.map((m) => m.id), [3]);
  assert.equal(p1.hasNextPage, false);
});

test("full sync sorts by ID and never stops early", async () => {
  const client = fakeClient([
    { hasNextPage: true, media: [{ id: 1, updatedAt: 1 }] },
    { hasNextPage: false, media: [{ id: 2, updatedAt: 1 }] },
  ]);
  const f = createAniListFetcher({ client: client as never });
  const p1 = await f.fetchPage(1);
  assert.deepEqual(client.calls[0]!.variables.sort, ["ID"]);
  assert.equal(p1.hasNextPage, true);
});

test("the query includes the incremental + studio fields", () => {
  assert.ok(ANILIST_PAGE_QUERY.includes("sort: $sort"));
  assert.ok(ANILIST_PAGE_QUERY.includes("updatedAt"));
  assert.ok(ANILIST_PAGE_QUERY.includes("bannerImage"));
  assert.ok(ANILIST_PAGE_QUERY.includes("nextAiringEpisode { airingAt episode }"));
  assert.ok(ANILIST_PAGE_QUERY.includes("studios { nodes { id name isAnimationStudio } }"));
});
