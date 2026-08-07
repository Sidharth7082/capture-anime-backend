/**
 * Unit tests for the Jikan anime normalizer (node:test, run via `npm test`).
 * Pure function coverage — no network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnimeItem, normalizeAnimeEnrichment, type JikanAnime } from "./normalizers.js";

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

test("metadata arrays are normalized from Jikan list items", () => {
  const row = normalizeAnimeItem({
    ...BASE,
    genres: [
      { mal_id: 1, name: "Action" },
      { mal_id: 46, name: "Award Winning" },
    ],
    themes: [{ mal_id: 29, name: "Space" }],
    demographics: [],
    studios: [{ mal_id: 14, name: "Sunrise" }],
    producers: [
      { mal_id: 23, name: "Bandai Visual" },
      { mal_id: 123, name: "Victor Entertainment" },
    ],
    licensors: [{ mal_id: 102, name: "Funimation" }],
  });
  assert.deepEqual(row.genres, [
    { malId: 1, name: "Action" },
    { malId: 46, name: "Award Winning" },
  ]);
  assert.deepEqual(row.themes, [{ malId: 29, name: "Space" }]);
  assert.deepEqual(row.demographics, []);
  assert.deepEqual(row.studios, [{ malId: 14, name: "Sunrise" }]);
  assert.deepEqual(row.producers, [
    { malId: 23, name: "Bandai Visual" },
    { malId: 123, name: "Victor Entertainment" },
  ]);
  assert.deepEqual(row.licensors, [{ malId: 102, name: "Funimation" }]);
});

test("metadata normalization drops invalid and duplicate entries", () => {
  const row = normalizeAnimeItem({
    ...BASE,
    genres: [
      { mal_id: 1, name: "Action" },
      { mal_id: 1, name: "Action" }, // duplicate mal_id
      { mal_id: 2, name: "" }, // missing name
      { mal_id: 3 }, // missing name
      { name: "No Id" }, // missing mal_id
      null,
      undefined,
    ] as never,
    studios: undefined,
    producers: null,
  });
  assert.deepEqual(row.genres, [{ malId: 1, name: "Action" }]);
  assert.deepEqual(row.studios, []);
  assert.deepEqual(row.producers, []);
});

test("enrichment bundle normalizes characters, staff, relations, recs, pictures, videos", () => {
  const row = normalizeAnimeEnrichment({
    mal_id: 1,
    characters: [
      {
        character: { mal_id: 3, name: "Black, Jet", name_kanji: "ジェット", images: { jpg: { image_url: "http://x/j.jpg" } } },
        role: "Main",
        voice_actors: [{ person: { mal_id: 357, name: "Ishizuka, Unshou" }, language: "Japanese" }],
      },
    ],
    staff: [{ person: { mal_id: 6519, name: "Minami, Masahiko" }, positions: ["Producer", "Producer"] }],
    relations: [{ relation: "Adaptation", entry: [{ mal_id: 173, type: "manga", name: "Cowboy Bebop" }] }],
    recommendations: [{ entry: { mal_id: 205, title: "Samurai Champloo" }, votes: 100 }],
    pictures: [{ jpg: { image_url: "http://x/p.jpg", large_image_url: "http://x/pl.jpg" }, webp: { image_url: "http://x/p.webp" } }],
    videos: {
      promo: [{ title: "PV 1", trailer: { youtube_id: "abc", embed_url: "http://e" } }],
      episodes: [{ episode: "Episode 26", title: "The Real Folk Blues (part 2)" }],
    },
  });
  assert.equal(row.idMal, 1);
  assert.equal(row.characters.length, 1);
  assert.equal(row.characters[0]!.role, "MAIN");
  assert.equal(row.characters[0]!.sortOrder, 0);
  assert.equal(row.characters[0]!.voiceActors[0]!.language, "Japanese");
  assert.equal(row.staff.length, 1);
  assert.deepEqual(row.staff[0]!.positions, ["Producer", "Producer"]);
  assert.deepEqual(row.relations, [{ malId: 173, mediaType: "manga", name: "Cowboy Bebop", relation: "Adaptation" }]);
  assert.deepEqual(row.recommendations, [{ malId: 205, title: "Samurai Champloo", votes: 100 }]);
  assert.deepEqual(row.pictures[0]!, { imageUrl: "http://x/p.jpg", largeImageUrl: "http://x/pl.jpg", webpUrl: "http://x/p.webp" });
  assert.equal(row.videos.length, 2);
  assert.equal(row.videos[0]!.kind, "promo");
  assert.equal(row.videos[0]!.youtubeId, "abc");
  assert.equal(row.videos[1]!.kind, "episode");
  assert.equal(row.videos[1]!.episodeNumber, 26);
  assert.equal(row.failedEndpoints.length, 0);
});

test("enrichment drops invalid entries and maps unknown roles to BACKGROUND", () => {
  const row = normalizeAnimeEnrichment({
    mal_id: 2,
    characters: [
      { character: { mal_id: 9, name: "Good" }, role: "Supporting" },
      { character: { mal_id: 9, name: "Dup" } }, // duplicate mal_id
      { character: { name: "No Id" } }, // missing mal_id
      null,
    ] as never,
    recommendations: [{ entry: { mal_id: 5, title: "" } }, { entry: {} }] as never,
    pictures: [{ jpg: { image_url: null } }] as never,
    videos: { episodes: [{ episode: "Episode 3", title: "" }] },
  });
  assert.equal(row.characters.length, 1);
  assert.equal(row.characters[0]!.role, "SUPPORTING");
  assert.equal(row.recommendations.length, 0);
  assert.equal(row.pictures.length, 0);
  assert.equal(row.videos.length, 1);
  assert.equal(row.videos[0]!.episodeNumber, 3);
});
