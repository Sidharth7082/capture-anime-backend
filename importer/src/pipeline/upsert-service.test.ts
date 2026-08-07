/**
 * Unit tests for the anime upsert service — slug generation + sync cursor
 * with an in-memory fake client (same pattern as the enrichment tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnimeUpsertService } from "./upsert-service.js";
import type { NormalizedAnime } from "./types.js";

interface Row {
  id: number;
  slug: string | null;
}

class FakeClient {
  statements: string[] = [];
  calls: Array<{ sql: string; params: unknown[] }> = [];
  existing: Row | null = null; // the anime row by id_mal
  slugTaken: string | null = null; // a slug owned by ANOTHER anime

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.statements.push(sql.trim().replace(/\s+/g, " "));
    this.calls.push({ sql: sql.trim().replace(/\s+/g, " "), params });
    const s = sql.trim();
    if (s.startsWith("SELECT id, slug FROM anime WHERE id_mal")) {
      return { rows: (this.existing ? [this.existing] : []) as T[] };
    }
    if (s.startsWith("SELECT 1 FROM anime WHERE slug")) {
      const slug = String(params[0]);
      return { rows: (this.slugTaken === slug ? [{ id: 999 }] : []) as T[] };
    }
    if (s.startsWith("SELECT id FROM genres WHERE mal_id") || s.startsWith("SELECT id FROM genres WHERE name")) {
      return { rows: [] as T[] };
    }
    if (s.includes("INSERT INTO genres")) {
      return { rows: [{ id: 1 }] as T[] };
    }
    if (s.includes("RETURNING id")) {
      return { rows: [{ id: 100 }] as T[] };
    }
    return { rows: [] as T[] };
  }
}

function fakeDb(client: FakeClient) {
  return { transaction: async <T>(fn: (c: FakeClient) => Promise<T>): Promise<T> => fn(client) } as never;
}

function callParams(client: FakeClient, prefix: string): unknown[] {
  const call = client.calls.find((c) => c.sql.startsWith(prefix));
  return call?.params ?? [];
}

const ROW: NormalizedAnime = {
  idMal: 1,
  titleRomaji: "Cowboy Bebop",
  titleEnglish: null,
  titleNative: null,
  synonyms: [],
  description: null,
  format: "TV",
  status: "FINISHED",
  episodes: 26,
  durationMinutes: 24,
  startDate: "1998-04-03",
  endDate: "1999-04-23",
  season: null,
  seasonYear: null,
  averageScore: 86,
  meanScore: null,
  popularity: 500000,
  favourites: 10000,
  source: null,
  isAdult: false,
  coverImageLarge: "http://x/l.jpg",
  coverImageMedium: null,
  genres: [{ malId: 1, name: "Action" }],
  themes: [],
  demographics: [],
  studios: [],
  producers: [],
  licensors: [],
};

test("insert path writes slug + last_synced_at", async () => {
  const client = new FakeClient();
  const svc = new AnimeUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  const insert = client.statements.find((s) => s.startsWith("INSERT INTO anime"));
  assert.ok(insert, "insert ran");
  assert.ok(insert!.includes("slug"), "insert includes slug column");
  assert.ok(insert!.includes("last_synced_at"), "insert includes last_synced_at");
  assert.ok(callParams(client, "INSERT INTO anime").includes("cowboy-bebop"), "title slug used");
});

test("insert appends -{malId} when the title slug is already taken", async () => {
  const client = new FakeClient();
  client.slugTaken = "cowboy-bebop";
  const svc = new AnimeUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  assert.ok(callParams(client, "INSERT INTO anime").includes("cowboy-bebop-1"), "collision slug used");
});

test("update keeps a stable title slug and bumps last_synced_at", async () => {
  const client = new FakeClient();
  client.existing = { id: 100, slug: "cowboy-bebop" };
  const svc = new AnimeUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  const update = client.statements.find((s) => s.startsWith("UPDATE anime"))!;
  assert.ok(update.includes("last_synced_at = now()"), "sync cursor bumped");
  assert.ok(update.includes("slug = $"), "slug in update");
  assert.ok(callParams(client, "UPDATE anime").includes("cowboy-bebop"), "stable slug preserved");
});

test("update replaces only the backfilled anime-{malId} fallback slug", async () => {
  const client = new FakeClient();
  client.existing = { id: 100, slug: "anime-1" };
  const svc = new AnimeUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  const update = client.statements.find((s) => s.startsWith("UPDATE anime"))!;
  assert.ok(update.includes("slug = $"), "slug in update");
  assert.ok(callParams(client, "UPDATE anime").includes("cowboy-bebop"), "fallback replaced with title slug");
});

test("metadata resolution bumps last_synced_at on an existing mal_id row", async () => {
  const client = new FakeClient();
  client.query = (async <T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
    client.statements.push(sql.trim().replace(/\s+/g, " "));
    const s = sql.trim();
    if (s.startsWith("SELECT id, slug FROM anime WHERE id_mal")) return { rows: [] as T[] };
    if (s.startsWith("SELECT 1 FROM anime WHERE slug")) return { rows: [] as T[] };
    if (s.startsWith("SELECT id FROM genres WHERE mal_id")) return { rows: [{ id: 5 }] as T[] }; // genre exists
    if (s.includes("RETURNING id")) return { rows: [{ id: 100 }] as T[] };
    return { rows: [] as T[] };
  }) as FakeClient["query"];

  const svc = new AnimeUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  const sync = client.statements.find((s) => s.startsWith("UPDATE genres SET last_synced_at"));
  assert.ok(sync, "existing genre row got last_synced_at bump");
});
