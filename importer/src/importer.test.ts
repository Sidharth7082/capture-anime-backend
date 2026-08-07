/**
 * Unit tests for Stage 1 normalization (node:test, run via `npm test`).
 * Pure function coverage — no network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnimeItem, type JikanAnime } from "./importer.js";

const BASE: JikanAnime = {
  mal_id: 16498,
  title: "Shingeki no Kyojin",
  title_english: "Attack on Titan",
  title_japanese: "進撃の巨人",
  title_synonyms: ["AoT", "SNK"],
  type: "TV",
  source: "Manga",
  status: "Finished Airing",
  episodes: 25,
  duration: "24 min per ep",
  rating: "R - 17+ (violence & profanity)",
  score: 8.55,
  members: 12_345,
  favorites: 4_321,
  season: "spring",
  year: 2013,
  synopsis: "<p>Humans fight titans.</p>",
  aired: { from: "2013-04-07T00:00:00+00:00", to: "2013-09-29T00:00:00+00:00" },
  images: {
    jpg: { image_url: "http://x/thumb.jpg", medium_image_url: "http://x/medium.jpg", large_image_url: "http://x/large.jpg" },
  },
};

test("maps a full Jikan item into the platform row", () => {
  const row = normalizeAnimeItem(BASE);
  assert.equal(row.idMal, 16498);
  assert.equal(row.titleRomaji, "Shingeki no Kyojin");
  assert.equal(row.titleEnglish, "Attack on Titan");
  assert.equal(row.titleNative, "進撃の巨人");
  assert.deepEqual(row.synonyms, ["AoT", "SNK"]);
  assert.equal(row.description, "<p>Humans fight titans.</p>");
  assert.equal(row.format, "TV");
  assert.equal(row.status, "FINISHED");
  assert.equal(row.source, "MANGA");
  assert.equal(row.episodes, 25);
  assert.equal(row.durationMinutes, 24);
  // score 0..10 -> 0..100
  assert.equal(row.averageScore, 86);
  assert.equal(row.meanScore, 86);
  assert.equal(row.popularity, 12_345);
  assert.equal(row.favourites, 4_321);
  assert.equal(row.season, "SPRING");
  assert.equal(row.seasonYear, 2013);
  assert.equal(row.startDate, "2013-04-07");
  assert.equal(row.endDate, "2013-09-29");
  assert.equal(row.isAdult, false);
  assert.equal(row.coverImageLarge, "http://x/large.jpg");
  assert.equal(row.coverImageMedium, "http://x/medium.jpg");
});

test("maps enum-ish fields with fallbacks for unknown values", () => {
  const row = normalizeAnimeItem({
    ...BASE,
    type: "WeirdThing",
    status: "Cancelled",
    source: "Web manga",
    season: "winter",
    score: 9.99,
    rating: "Rx - Hentai",
  });
  assert.equal(row.format, null); // unknown Jikan type -> null (not a crash)
  assert.equal(row.status, null); // unknown status -> null
  assert.equal(row.source, null); // unlisted source -> null
  assert.equal(row.season, "WINTER");
  assert.equal(row.averageScore, 100); // clamped to 0..100
  assert.equal(row.isAdult, true); // Rx -> adult
});

test("handles missing/partial data without throwing", () => {
  const row = normalizeAnimeItem({ mal_id: 1, title: "X" });
  assert.equal(row.titleEnglish, null);
  assert.equal(row.titleNative, null);
  assert.deepEqual(row.synonyms, []);
  assert.equal(row.description, null);
  assert.equal(row.format, null);
  assert.equal(row.status, null);
  assert.equal(row.episodes, null);
  assert.equal(row.durationMinutes, null);
  assert.equal(row.averageScore, null);
  assert.equal(row.popularity, null);
  assert.equal(row.favourites, null);
  assert.equal(row.season, null);
  assert.equal(row.seasonYear, null);
  assert.equal(row.startDate, null);
  assert.equal(row.endDate, null);
  assert.equal(row.isAdult, false);
  assert.equal(row.coverImageLarge, null);
});

test("guards dates, duration and year against bad values", () => {
  // end before start -> drop end (anime_dates_check: end >= start)
  const badDates = normalizeAnimeItem({
    ...BASE,
    aired: { from: "2020-01-10T00:00:00+00:00", to: "2020-01-01T00:00:00+00:00" },
  });
  assert.equal(badDates.startDate, "2020-01-10");
  assert.equal(badDates.endDate, null);

  // year out of the 1917..2100 range -> null
  assert.equal(normalizeAnimeItem({ ...BASE, year: 1800 }).seasonYear, null);
  assert.equal(normalizeAnimeItem({ ...BASE, year: null }).seasonYear, null);

  // duration parsing tolerates variants
  assert.equal(normalizeAnimeItem({ ...BASE, duration: "1 hr 30 min" }).durationMinutes, 30);
  assert.equal(normalizeAnimeItem({ ...BASE, duration: "90 min" }).durationMinutes, 90);
  assert.equal(normalizeAnimeItem({ ...BASE, duration: null }).durationMinutes, null);
  assert.equal(normalizeAnimeItem({ ...BASE, duration: "Unknown" }).durationMinutes, null);
});

test("negative counts are clamped to 0 (CHECK constraints)", () => {
  const row = normalizeAnimeItem({ ...BASE, episodes: -3, members: -5, favorites: -1, score: -2 });
  assert.equal(row.episodes, 0);
  assert.equal(row.popularity, 0);
  assert.equal(row.favourites, 0);
  assert.equal(row.averageScore, 0);
});
