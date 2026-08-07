/**
 * Duplicate-prevention tests for the AniList canonical source: match by
 * anilist_id first, then id_mal — a re-sync or a Jikan-created row must
 * always UPDATE, never INSERT a second copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AniListUpsertService } from "./anilist-upsert-service.js";
import { normalizeAniListItem } from "./normalizers.js";
import type { AniListMedia } from "./normalizers.js";

const MEDIA: AniListMedia = {
  id: 12345,
  idMal: 1,
  title: { romaji: "Cowboy Bebop", english: "Cowboy Bebop" },
  format: "TV",
  status: "FINISHED",
  episodes: 26,
  averageScore: 86,
  genres: ["Action", "Sci-Fi"],
  studios: { nodes: [{ id: 14, name: "Sunrise", isAnimationStudio: true }] },
  bannerImage: "http://x/b.jpg",
};

/** Fake DB keyed by what the "anime" table contains. */
function makeDb(initial: { anilistId?: number | null; idMal?: number | null } | null) {
  const statements: string[] = [];
  let row = initial ? { id: 100, ...initial } : null;
  const db = {
    statements,
    get row() {
      return row;
    },
    transaction: (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        async query<T = { id: number }>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
          statements.push(sql.trim().replace(/\s+/g, " "));
          const s = sql.trim();
          if (s.startsWith("SELECT id FROM anime WHERE anilist_id")) {
            return { rows: row?.anilistId === Number(params[0]) ? [{ id: row.id }] : [] } as { rows: T[] };
          }
          if (s.startsWith("SELECT id FROM anime WHERE id_mal")) {
            return { rows: row?.idMal === Number(params[0]) ? [{ id: row.id }] : [] } as { rows: T[] };
          }
          if (s.startsWith("SELECT id FROM genres WHERE name")) {
            return { rows: [] as T[] };
          }
          if (s.includes("INSERT INTO genres")) return { rows: [{ id: 500 }] as T[] };
          if (s.startsWith("SELECT id FROM studios WHERE anilist_id") || s.startsWith("SELECT id FROM studios WHERE name")) {
            return { rows: [] as T[] };
          }
          if (s.includes("INSERT INTO studios")) return { rows: [{ id: 600 }] as T[] };
          if (s.startsWith("UPDATE anime SET")) {
            row = { id: row!.id, anilistId: Number(params[1]), idMal: params[0] != null ? Number(params[0]) : null };
            return { rows: [] as T[] };
          }
          if (s.startsWith("INSERT INTO anime (")) {
            const anilist = Number(params[1]);
            const idMal = params[0] != null ? Number(params[0]) : null;
            row = { id: 100, anilistId: anilist, idMal };
            return { rows: [{ id: 100 }] as T[] };
          }
          return { rows: [] as T[] };
        },
      }),
  };
  return db;
}

test("new AniList anime is inserted once with both keys", async () => {
  const db = makeDb(null);
  const svc = new AniListUpsertService(db as never);
  const outcome = await svc.upsert(normalizeAniListItem(MEDIA));
  assert.equal(outcome, "inserted");
  assert.deepEqual(db.row, { id: 100, anilistId: 12345, idMal: 1 });
  assert.equal(db.statements.filter((s) => s.startsWith("INSERT INTO anime (")).length, 1);
});

test("re-syncing the same AniList anime UPDATES, never duplicates", async () => {
  const db = makeDb({ anilistId: 12345, idMal: 1 });
  const svc = new AniListUpsertService(db as never);
  const outcome = await svc.upsert(normalizeAniListItem(MEDIA));
  assert.equal(outcome, "updated");
  const inserts = db.statements.filter((s) => s.startsWith("INSERT INTO anime ("));
  assert.equal(inserts.length, 0, "no second row for an existing anilist_id");
  assert.ok(db.statements.some((s) => s.startsWith("UPDATE anime SET")), "row updated in place");
});

test("Jikan-created row (id_mal only) is matched by MAL id and filled with anilist_id", async () => {
  const db = makeDb({ anilistId: null, idMal: 1 });
  const svc = new AniListUpsertService(db as never);
  const outcome = await svc.upsert(normalizeAniListItem(MEDIA));
  assert.equal(outcome, "updated");
  assert.equal(db.statements.filter((s) => s.startsWith("INSERT INTO anime (")).length, 0);
  assert.ok(db.statements.some((s) => s.startsWith("UPDATE anime SET")), "existing Jikan row updated");
  assert.equal(db.row!.anilistId, 12345, "anilist_id backfilled onto the Jikan row");
});

test("genres resolve by name and studios by AniList id", async () => {
  const db = makeDb(null);
  const svc = new AniListUpsertService(db as never);
  await svc.upsert(normalizeAniListItem(MEDIA));
  const all = db.statements.join("\n");
  assert.ok(all.includes('INSERT INTO genres (name) VALUES ($1) RETURNING id'), "genre created by name");
  assert.ok(all.includes('INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'), "genre join written");
  assert.ok(all.includes('INSERT INTO studios (anilist_id, name, is_animation_studio)'), "studio created by anilist id");
  assert.ok(all.includes('INSERT INTO anime_studios (anime_id, studio_id, is_main)'), "studio join written");
});

test("anime without anilistId is skipped (nothing to match on)", async () => {
  const db = makeDb(null);
  const svc = new AniListUpsertService(db as never);
  const row = normalizeAniListItem(MEDIA);
  const outcome = await svc.upsert({ ...row, anilistId: null });
  assert.equal(outcome, "updated");
  assert.equal(db.statements.filter((s) => s.startsWith("INSERT INTO anime (") || s.startsWith("UPDATE anime")).length, 0);
});
