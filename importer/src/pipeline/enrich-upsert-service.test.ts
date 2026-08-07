/**
 * Unit tests for the enrichment upsert service — an in-memory fake client
 * records every statement so we can assert the per-anime transaction shape:
 * entity resolution, join writes, stale pruning, replace-per-anime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnimeEnrichUpsertService } from "./enrich-upsert-service.js";
import type { NormalizedAnimeEnrichment } from "./types.js";

interface Row {
  id: number;
}

class FakeClient {
  statements: string[] = [];
  private ids = { anime: 100, character: 10, staff: 20 };
  /** Anime rows already in the catalog (id_mal -> id). */
  catalog: Map<number, number> = new Map([[1, 100]]);

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.statements.push(sql.trim().replace(/\s+/g, " "));
    const s = sql.trim();

    if (s.startsWith("SELECT id FROM anime WHERE id_mal")) {
      const id = this.catalog.get(Number(params[0]));
      return { rows: id != null ? ([{ id }] as T[]) : [] };
    }
    if (s.startsWith("SELECT id FROM characters WHERE mal_id")) {
      return { rows: [] }; // always "new" characters
    }
    if (s.startsWith("SELECT id FROM characters WHERE name_first")) {
      return { rows: [] };
    }
    if (s.startsWith("SELECT id FROM staff WHERE mal_id") || s.startsWith("SELECT id FROM staff WHERE name_first")) {
      return { rows: [] };
    }
    if (s.startsWith("SELECT character_id FROM anime_characters")) {
      return { rows: [] }; // no prior joins
    }
    if (s.includes("RETURNING id")) {
      if (s.includes("characters")) return { rows: [{ id: this.ids.character }] as T[] };
      if (s.includes("staff")) return { rows: [{ id: this.ids.staff }] as T[] };
      return { rows: [{ id: this.ids.anime }] as T[] };
    }
    return { rows: [] };
  }
}

function fakeDb(client: FakeClient) {
  return {
    transaction: async <T>(fn: (c: FakeClient) => Promise<T>): Promise<T> => fn(client),
  } as never;
}

const ROW: NormalizedAnimeEnrichment = {
  idMal: 1,
  failedEndpoints: [],
  characters: [
    {
      malId: 3,
      name: "Black, Jet",
      nameKanji: "ジェット",
      imageUrl: "http://x/j.jpg",
      role: "MAIN",
      sortOrder: 0,
      voiceActors: [{ malId: 357, name: "Ishizuka, Unshou", imageUrl: null, language: "Japanese" }],
    },
  ],
  staff: [{ malId: 6519, name: "Minami, Masahiko", imageUrl: null, positions: ["Producer"] }],
  relations: [{ malId: 173, mediaType: "manga", name: "Cowboy Bebop", relation: "Adaptation" }],
  recommendations: [{ malId: 205, title: "Samurai Champloo", votes: 100 }],
  pictures: [{ imageUrl: "http://x/p.jpg", largeImageUrl: null, webpUrl: null }],
  videos: [{ kind: "promo", title: "PV 1", youtubeId: "abc", url: null, embedUrl: null, thumbnailLarge: null, episodeNumber: null }],
};

test("enrich upsert writes all six content groups inside one transaction", async () => {
  const client = new FakeClient();
  const svc = new AnimeEnrichUpsertService(fakeDb(client) as never);
  const outcome = await svc.upsert(ROW);
  assert.equal(outcome, "updated");

  const all = client.statements.join("\n");
  assert.ok(all.includes("INSERT INTO anime_characters"), "character join written");
  assert.ok(all.includes("INSERT INTO character_staff"), "voice actor link written");
  assert.ok(all.includes("INSERT INTO anime_staff"), "staff positions written");
  assert.ok(all.includes("DELETE FROM anime_relations WHERE anime_id"), "relations replaced");
  assert.ok(all.includes("INSERT INTO anime_relations"), "relation inserted");
  assert.ok(all.includes("INSERT INTO anime_recommendations"), "recommendation inserted");
  assert.ok(all.includes("INSERT INTO anime_pictures"), "picture inserted");
  assert.ok(all.includes("INSERT INTO anime_videos"), "video inserted");
});

test("enrich upsert skips anime that are not in the catalog", async () => {
  const client = new FakeClient();
  const svc = new AnimeEnrichUpsertService(fakeDb(client) as never);
  const outcome = await svc.upsert({ ...ROW, idMal: 999 });
  assert.equal(outcome, "updated");
  assert.ok(!client.statements.some((s) => s.includes("INSERT INTO anime_characters")), "no writes for unknown anime");
});

test("enrich upsert prunes stale character and staff joins", async () => {
  const client = new FakeClient();
  // Pretend the anime already has a character (id 55) that is no longer listed.
  client.query = async <T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
    client.statements.push(sql.trim().replace(/\s+/g, " "));
    const s = sql.trim();
    if (s.startsWith("SELECT id FROM anime WHERE id_mal")) return { rows: [{ id: 100 }] as T[] };
    if (s.startsWith("SELECT id FROM characters WHERE mal_id")) return { rows: [] as T[] };
    if (s.startsWith("SELECT id FROM characters WHERE name_first")) return { rows: [] as T[] };
    if (s.startsWith("SELECT id FROM staff WHERE mal_id") || s.startsWith("SELECT id FROM staff WHERE name_first")) return { rows: [] as T[] };
    if (s.startsWith("SELECT character_id FROM anime_characters")) return { rows: [{ character_id: 55 }] as unknown as T[] };
    if (s.includes("RETURNING id")) {
      if (s.includes("characters")) return { rows: [{ id: 10 }] as T[] };
      if (s.includes("staff")) return { rows: [{ id: 20 }] as T[] };
      return { rows: [{ id: 100 }] as T[] };
    }
    return { rows: [] as T[] };
  };

  const svc = new AnimeEnrichUpsertService(fakeDb(client) as never);
  await svc.upsert(ROW);
  const all = client.statements.join("\n");
  assert.ok(
    all.includes("DELETE FROM anime_characters WHERE anime_id = $1 AND character_id NOT IN"),
    "stale character join pruned",
  );
  assert.ok(
    all.includes("DELETE FROM anime_staff WHERE anime_id = $1 AND staff_id NOT IN"),
    "stale staff join pruned",
  );
});

test("a failed characters endpoint does NOT delete existing character data", async () => {
  const statements: string[] = [];
  const db = {
    transaction: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        async query<T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
          statements.push(sql.trim().replace(/\s+/g, " "));
          const s = sql.trim();
          if (s.startsWith("SELECT id FROM anime WHERE id_mal")) return { rows: [{ id: 100 }] as T[] };
          if (s.startsWith("SELECT character_id FROM anime_characters")) return { rows: [] as T[] };
          if (s.includes("RETURNING id")) return { rows: [{ id: 10 }] as T[] };
          return { rows: [] as T[] };
        },
      }),
  };

  const svc = new AnimeEnrichUpsertService(db as never);
  await svc.upsert({ ...ROW, failedEndpoints: ["characters", "staff", "pictures", "videos"], staff: [], pictures: [], videos: [] });

  const all = statements.join("\n");
  assert.ok(!all.includes("anime_characters"), "no character writes when the endpoint failed");
  assert.ok(!all.includes("character_staff"), "no VA writes when the endpoint failed");
  assert.ok(all.includes("INSERT INTO anime_recommendations"), "succeeded endpoints still written");
});

test("empty new character list still prunes old voice-actor links (old-id based)", async () => {
  const statements: string[] = [];
  const db = {
    transaction: async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        async query<T = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
          statements.push(sql.trim().replace(/\s+/g, " "));
          const s = sql.trim();
          if (s.startsWith("SELECT id FROM anime WHERE id_mal")) return { rows: [{ id: 100 }] as T[] };
          if (s.startsWith("SELECT character_id FROM anime_characters")) return { rows: [{ character_id: 55 }, { character_id: 66 }] as unknown as T[] };
          if (s.includes("RETURNING id")) return { rows: [{ id: 10 }] as T[] };
          return { rows: [] as T[] };
        },
      }),
  };

  const svc = new AnimeEnrichUpsertService(db as never);
  await svc.upsert({ ...ROW, characters: [] });

  const all = statements.join("\n");
  assert.ok(
    all.includes("DELETE FROM character_staff WHERE character_id = ANY($1::bigint[]) AND character_id NOT IN (NULL)"),
    "VA links for removed characters are pruned even when the new list is empty",
  );
  assert.ok(all.includes("DELETE FROM anime_characters WHERE anime_id = $1"), "character joins cleared");
});
