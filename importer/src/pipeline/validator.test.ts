/**
 * Unit tests for the row validator (node:test, run via `npm test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnimeRow } from "./validator.js";
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
