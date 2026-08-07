/**
 * Unit tests for the Typesense sink mapping (pure functions only — no
 * network; the client itself is exercised by the live E2E script).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnimeDocument, ANIME_COLLECTION_FIELDS } from "./typesense.js";
import { normalizeAnimeItem, type JikanAnime } from "./pipeline/normalizers.js";

const ITEM: JikanAnime = {
  mal_id: 16498,
  title: "Shingeki no Kyojin",
  type: "TV",
  status: "Finished Airing",
  episodes: 25,
  score: 8.55,
  season: "spring",
  year: 2013,
  synopsis: "Humans fight <b>titans</b>.<br/>It is dark.<br/>",
  genres: [{ mal_id: 1, name: "Action" }, { mal_id: 46, name: "Award Winning" }],
  studios: [{ mal_id: 14, name: "Wit Studio" }],
  producers: [{ mal_id: 23, name: "Pony Canyon" }],
  members: 2500000,
  favorites: 120000,
  images: { jpg: { large_image_url: "http://x/l.jpg" } },
};

test("doc id is stable and keyed by mal_id (upsert-safe across reimports)", () => {
  const doc = toAnimeDocument(normalizeAnimeItem(ITEM));
  assert.equal(doc.id, "anime:16498");
  assert.equal(doc.mal_id, 16498);
});

test("doc mapping flattens metadata to name arrays and strips HTML from synopsis", () => {
  const doc = toAnimeDocument(normalizeAnimeItem(ITEM));
  assert.deepEqual(doc.genres, ["Action", "Award Winning"]);
  assert.deepEqual(doc.studios, ["Wit Studio"]);
  assert.deepEqual(doc.producers, ["Pony Canyon"]);
  assert.equal(doc.synopsis, "Humans fight titans.\nIt is dark.");
  assert.equal(doc.title_romaji, "Shingeki no Kyojin");
  assert.equal(doc.score, 86); // 8.55 * 10 rounded
  assert.equal(doc.is_adult, false);
});

test("collection schema has a default_sorting_field-compatible popularity", () => {
  const popularity = ANIME_COLLECTION_FIELDS.find((f) => f.name === "popularity");
  assert.ok(popularity);
  assert.equal(popularity.type, "int32");
  const required = ["mal_id", "title_romaji", "genres", "studios", "synopsis", "is_adult"];
  for (const name of required) {
    assert.ok(ANIME_COLLECTION_FIELDS.some((f) => f.name === name), `missing field ${name}`);
  }
});
