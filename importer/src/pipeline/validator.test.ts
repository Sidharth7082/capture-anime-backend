/**
 * Unit tests for the row validator (node:test, run via `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnimeRow, validateAnimeEnrichment } from "./validator.js";
import { normalizeAnimeItem, type JikanAnime } from "./normalizers.js";

const VALID_ITEM: JikanAnime = {
  mal_id: 16498,
  title: "Shingeki no Kyojin",
  type: "TV",
  status: "Finished Airing",
  episodes: 25,
  score: 8.55,
  season: "spring",
  year: 2013,
  aired: { from: "2013-04-07T00:00:00+00:00", to: "2013-09-29T00:00:00+00:00" },
  images: { jpg: { large_image_url: "http://x/l.jpg" } },
};

test("accepts a well-formed normalized row", () => {
  const check = validateAnimeRow(normalizeAnimeItem(VALID_ITEM));
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.row.idMal, 16498);
});

test("rejects rows that would violate a CHECK constraint", () => {
  const row = normalizeAnimeItem(VALID_ITEM);
  const bad = validateAnimeRow({ ...row, averageScore: 150, episodes: -1, seasonYear: 100 });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.reason, /averageScore/);
    assert.match(bad.reason, /episodes/);
    assert.match(bad.reason, /seasonYear/);
  }
});

test("rejects a missing mal_id", () => {
  const row = normalizeAnimeItem(VALID_ITEM);
  const bad = validateAnimeRow({ ...row, idMal: 0 });
  assert.equal(bad.ok, false);
});

test("accepts a minimal row (all nulls) since the table allows nulls", () => {
  const check = validateAnimeRow(normalizeAnimeItem({ mal_id: 1, title: "X" }));
  assert.equal(check.ok, true);
});

test("accepts metadata arrays on a well-formed row", () => {
  const row = normalizeAnimeItem({
    ...VALID_ITEM,
    genres: [{ mal_id: 1, name: "Action" }],
    themes: [{ mal_id: 29, name: "Space" }],
    studios: [{ mal_id: 14, name: "Sunrise" }],
    producers: [{ mal_id: 23, name: "Bandai Visual" }],
    licensors: [{ mal_id: 102, name: "Funimation" }],
    demographics: [],
  });
  const check = validateAnimeRow(row);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.row.genres.length, 1);
});

test("rejects malformed metadata refs", () => {
  const row = normalizeAnimeItem(VALID_ITEM);
  const bad = validateAnimeRow({
    ...row,
    genres: [{ malId: 0, name: "Bad" }], // malId must be positive
    themes: [{ malId: 1, name: "" }], // name must be non-empty
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.reason, /genres.0.malId/);
    assert.match(bad.reason, /themes.0.name/);
  }
});

test("enrichment validator accepts a full bundle and rejects broken ones", () => {
  const ok = validateAnimeEnrichment({
    idMal: 1,
    failedEndpoints: [],
    characters: [{ malId: 3, name: "Black, Jet", nameKanji: null, imageUrl: null, role: "MAIN", sortOrder: 0, voiceActors: [] }],
    staff: [],
    relations: [{ malId: 173, mediaType: "manga", name: "Cowboy Bebop", relation: "Adaptation" }],
    recommendations: [],
    pictures: [],
    videos: [],
  });
  assert.equal(ok.ok, true);

  const badRole = validateAnimeEnrichment({
    idMal: 1,
    failedEndpoints: [],
    characters: [{ malId: 3, name: "X", nameKanji: null, imageUrl: null, role: "TOTALLY_WRONG" as never, sortOrder: 0, voiceActors: [] }],
    staff: [],
    relations: [],
    recommendations: [],
    pictures: [],
    videos: [],
  });
  assert.equal(badRole.ok, false);
  if (!badRole.ok) assert.match(badRole.reason, /characters.0.role/);
});

test("enrichment validator rejects a row where every endpoint failed", () => {
  const check = validateAnimeEnrichment({
    idMal: 1,
    failedEndpoints: ["characters", "staff", "relations", "recommendations", "pictures", "videos"],
    characters: [],
    staff: [],
    relations: [],
    recommendations: [],
    pictures: [],
    videos: [],
  });
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.reason, /all endpoints failed/);
});

test("anime row without any external id is rejected", () => {
  const row = normalizeAnimeItem(VALID_ITEM);
  const bad = validateAnimeRow({ ...row, idMal: null });
  assert.equal(bad.ok, false);
});
