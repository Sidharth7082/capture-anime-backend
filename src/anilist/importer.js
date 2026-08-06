// ============================================================================
// AniList -> PostgreSQL importer.
//
// Each media item is imported inside its own transaction:
//   anime  -> genres + anime_genres (pruned)
//          -> studios + anime_studios (pruned)
//          -> numbered episode placeholders (AniList only exposes a count)
//          -> characters + anime_characters
//          -> voice actors (staff) + character_staff
//
// Every write is an UPSERT keyed on the AniList natural id, so re-running the
// importer is idempotent: it refreshes metadata instead of duplicating rows.
//
// Deliberate non-goals:
//   * anime_characters is NOT pruned when a character drops out of the first
//     page — we only fetch up to `charactersPerPage` (max 25) per title, so
//     pruning would delete characters we never looked at. The same applies to
//     character_staff. (Genres and studios are returned in full, so those
//     relations ARE pruned.)
// ============================================================================

import { getPool } from '../db.js';
import { PAGE_MEDIA_QUERY, MEDIA_BY_ID_QUERY } from './queries.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** AniList dates are { year, month, day } objects; build 'YYYY-MM-DD' or null. */
function buildDate(d) {
  if (!d || !d.year || !d.month || !d.day) return null;
  const y = String(d.year).padStart(4, '0');
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nullish(value) {
  return value === null || value === undefined || value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Per-entity upserts
// ---------------------------------------------------------------------------

async function upsertAnime(client, media) {
  const { rows } = await client.query(
    `INSERT INTO anime (
       anilist_id, id_mal, media_type, title_romaji, title_english, title_native, synonyms,
       description, format, status, episodes, duration_minutes,
       start_date, end_date, season, season_year,
       average_score, mean_score, popularity, favourites, source, is_adult,
       cover_image_large, cover_image_medium, cover_image_color, banner_image,
       trailer_id, trailer_site, trailer_thumbnail
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29
     )
     ON CONFLICT (anilist_id) DO UPDATE SET
       id_mal              = EXCLUDED.id_mal,
       media_type          = EXCLUDED.media_type,
       title_romaji        = EXCLUDED.title_romaji,
       title_english       = EXCLUDED.title_english,
       title_native        = EXCLUDED.title_native,
       synonyms            = EXCLUDED.synonyms,
       description         = EXCLUDED.description,
       format              = EXCLUDED.format,
       status              = EXCLUDED.status,
       episodes            = EXCLUDED.episodes,
       duration_minutes    = EXCLUDED.duration_minutes,
       start_date          = EXCLUDED.start_date,
       end_date            = EXCLUDED.end_date,
       season              = EXCLUDED.season,
       season_year         = EXCLUDED.season_year,
       average_score       = EXCLUDED.average_score,
       mean_score          = EXCLUDED.mean_score,
       popularity          = EXCLUDED.popularity,
       favourites          = EXCLUDED.favourites,
       source              = EXCLUDED.source,
       is_adult            = EXCLUDED.is_adult,
       cover_image_large   = EXCLUDED.cover_image_large,
       cover_image_medium  = EXCLUDED.cover_image_medium,
       cover_image_color   = EXCLUDED.cover_image_color,
       banner_image        = EXCLUDED.banner_image,
       trailer_id          = EXCLUDED.trailer_id,
       trailer_site        = EXCLUDED.trailer_site,
       trailer_thumbnail   = EXCLUDED.trailer_thumbnail
     RETURNING id`,
    [
      media.id,
      nullish(media.idMal),
      nullish(media.type) ?? 'ANIME',
      nullish(media.title?.romaji),
      nullish(media.title?.english),
      nullish(media.title?.native),
      media.synonyms ?? [],
      nullish(media.description),
      nullish(media.format),
      nullish(media.status),
      nullish(media.episodes),
      nullish(media.duration),
      buildDate(media.startDate),
      buildDate(media.endDate),
      nullish(media.season),
      nullish(media.seasonYear),
      nullish(media.averageScore),
      nullish(media.meanScore),
      nullish(media.popularity),
      nullish(media.favourites),
      nullish(media.source),
      Boolean(media.isAdult),
      nullish(media.coverImage?.extraLarge) ?? nullish(media.coverImage?.large),
      nullish(media.coverImage?.large) ?? nullish(media.coverImage?.medium),
      nullish(media.coverImage?.color),
      nullish(media.bannerImage),
      nullish(media.trailer?.id),
      nullish(media.trailer?.site),
      nullish(media.trailer?.thumbnail),
    ],
  );
  return rows[0].id;
}

/**
 * Upserts genres and rewires anime_genres so the link set matches the API
 * exactly (AniList returns the full genre list).
 */
async function syncGenres(client, animeId, genres) {
  const kept = [];
  for (const name of genres) {
    const { rows } = await client.query(
      `INSERT INTO genres (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name],
    );
    kept.push(rows[0].id);
    await client.query(
      `INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [animeId, rows[0].id],
    );
  }
  await client.query(
    `DELETE FROM anime_genres
      WHERE anime_id = $1 AND genre_id <> ALL($2::bigint[])`,
    [animeId, kept],
  );
}

/** Same contract as syncGenres but for studios (is_main flag preserved). */
async function syncStudios(client, animeId, edges) {
  const kept = [];
  for (const edge of edges ?? []) {
    const studio = edge?.node;
    if (!studio) continue;
    const { rows } = await client.query(
      `INSERT INTO studios (anilist_id, name, is_animation_studio)
       VALUES ($1, $2, $3)
       ON CONFLICT (anilist_id) DO UPDATE SET
         name = EXCLUDED.name,
         is_animation_studio = EXCLUDED.is_animation_studio
       RETURNING id`,
      [studio.id, studio.name, Boolean(studio.isAnimationStudio)],
    );
    const studioId = rows[0].id;
    kept.push(studioId);
    await client.query(
      `INSERT INTO anime_studios (anime_id, studio_id, is_main) VALUES ($1, $2, $3)
       ON CONFLICT (anime_id, studio_id) DO UPDATE SET is_main = EXCLUDED.is_main`,
      [animeId, studioId, Boolean(edge.isMain)],
    );
  }
  await client.query(
    `DELETE FROM anime_studios
      WHERE anime_id = $1 AND studio_id <> ALL($2::bigint[])`,
    [animeId, kept],
  );
}

/**
 * AniList has no per-episode data, only a count. Seed numbered placeholder
 * rows so watch history / comments have concrete episodes to attach to.
 */
async function seedEpisodes(client, animeId, count) {
  if (!Number.isInteger(count) || count <= 0) return;
  await client.query(
    `INSERT INTO episodes (anime_id, number)
     SELECT $1, g FROM generate_series(1, $2) AS g
     ON CONFLICT (anime_id, number) DO NOTHING`,
    [animeId, count],
  );
}

async function upsertCharacter(client, node) {
  const { rows } = await client.query(
    `INSERT INTO characters (
       anilist_id, name_first, name_last, name_native, description,
       image_large, image_medium, favourites
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (anilist_id) DO UPDATE SET
       name_first   = EXCLUDED.name_first,
       name_last    = EXCLUDED.name_last,
       name_native  = EXCLUDED.name_native,
       description  = EXCLUDED.description,
       image_large  = EXCLUDED.image_large,
       image_medium = EXCLUDED.image_medium,
       favourites   = EXCLUDED.favourites
     RETURNING id`,
    [
      node.id,
      nullish(node.name?.first) || '',
      nullish(node.name?.last),
      nullish(node.name?.native),
      nullish(node.description),
      nullish(node.image?.large),
      nullish(node.image?.medium),
      nullish(node.favourites) ?? 0,
    ],
  );
  return rows[0].id;
}

async function linkAnimeCharacter(client, animeId, characterId, edge) {
  await client.query(
    `INSERT INTO anime_characters (anime_id, character_id, role, sort_order, favourites)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (anime_id, character_id) DO UPDATE SET
       role       = EXCLUDED.role,
       sort_order = EXCLUDED.sort_order,
       favourites = EXCLUDED.favourites`,
    [
      animeId,
      characterId,
      edge.role ?? 'SUPPORTING',
      nullish(edge.favouriteOrder) ?? 0,
      nullish(edge.node?.favourites) ?? 0,
    ],
  );
}

async function upsertStaff(client, va) {
  const { rows } = await client.query(
    `INSERT INTO staff (
       anilist_id, name_first, name_last, name_native, language, image_large
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (anilist_id) DO UPDATE SET
       name_first  = EXCLUDED.name_first,
       name_last   = EXCLUDED.name_last,
       name_native = EXCLUDED.name_native,
       language    = EXCLUDED.language,
       image_large = EXCLUDED.image_large
     RETURNING id`,
    [
      va.id,
      nullish(va.name?.first) || '',
      nullish(va.name?.last),
      nullish(va.name?.native),
      nullish(va.languageV2) ?? 'Japanese',
      nullish(va.image?.large),
    ],
  );
  return rows[0].id;
}

async function linkCharacterStaff(client, characterId, staffId, language) {
  await client.query(
    `INSERT INTO character_staff (character_id, staff_id, language)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [characterId, staffId, language],
  );
}

// ---------------------------------------------------------------------------
// Top-level per-media import
// ---------------------------------------------------------------------------

/**
 * Imports one AniList media object using an already-connected client
 * (the caller owns the transaction). Returns counts of what was linked.
 */
export async function importMediaWithClient(client, media, { skipEpisodes = false } = {}) {
  const animeId = await upsertAnime(client, media);

  const genres = media.genres ?? [];
  await syncGenres(client, animeId, genres);

  const studioEdges = media.studios?.edges ?? [];
  await syncStudios(client, animeId, studioEdges);

  let episodeCount = 0;
  if (!skipEpisodes && media.episodes) {
    await seedEpisodes(client, animeId, media.episodes);
    episodeCount = media.episodes;
  }

  const characterEdges = media.characters?.edges ?? [];
  for (const edge of characterEdges) {
    const characterId = await upsertCharacter(client, edge.node);
    await linkAnimeCharacter(client, animeId, characterId, edge);

    for (const va of edge.voiceActors ?? []) {
      const staffId = await upsertStaff(client, va);
      await linkCharacterStaff(
        client,
        characterId,
        staffId,
        nullish(va.languageV2) ?? 'Japanese',
      );
    }
  }

  return {
    animeId,
    genres: genres.length,
    studios: studioEdges.length,
    episodes: episodeCount,
    characters: characterEdges.length,
  };
}

/**
 * Imports one AniList media object through a pg.Pool, inside its own
 * transaction: a failure mid-title leaves nothing half-written.
 */
export async function importMedia(pool, media, options) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await importMediaWithClient(client, media, options);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(
      `importing anime #${media.id} (${media.title?.romaji ?? media.title?.english ?? '?'}): ${err.message}`,
    );
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Catalog-level import (paginated)
// ---------------------------------------------------------------------------

/**
 * Builds the variables for the paginated catalog query from CLI options.
 * Unset filters are OMITTED, not passed as null — AniList treats an explicit
 * null enum argument as "match rows where the field is null", so passing a
 * batch of nulls silently returns zero media.
 * isAdult: false excludes adult titles; includeAdult omits the filter.
 */
export function pageVariables({
  page,
  perPage,
  type,
  sort,
  season,
  seasonYear,
  format,
  status,
  includeAdult,
  charactersPerPage,
  vaLanguage,
}) {
  const variables = {
    page,
    perPage,
    charactersPage: 1,
    charactersPerPage,
    vaLanguage: vaLanguage ?? 'JAPANESE',
  };
  if (type) variables.type = type;
  variables.sort = sort ? [sort] : ['POPULARITY_DESC'];
  if (season) variables.season = season;
  if (seasonYear) variables.seasonYear = seasonYear;
  if (format) variables.format = format;
  if (status) variables.status = status;
  if (!includeAdult) variables.isAdult = false;
  return variables;
}

/**
 * Imports pages of media until hasNextPage is false or maxPages is reached.
 * Returns { totalMedia, totalCharacters, pages }.
 */
export async function importCatalog(anilist, {
  startPage = 1,
  perPage = 50,
  maxPages = null,
  includeAdult = false,
  type = 'ANIME',
  sort = 'POPULARITY_DESC',
  season = null,
  seasonYear = null,
  format = null,
  status = null,
  charactersPerPage = 25,
  vaLanguage = 'JAPANESE',
  onPage = null,
} = {}) {
  const pool = getPool();
  let page = startPage;
  let totalMedia = 0;
  let totalCharacters = 0;
  let pages = 0;

  while (true) {
    const variables = pageVariables({
      page, perPage, type, sort, season, seasonYear, format, status,
      includeAdult, charactersPerPage, vaLanguage,
    });
    const data = await anilist.query(PAGE_MEDIA_QUERY, variables);
    const { media, pageInfo } = data.Page;
    pages += 1;

    for (const item of media) {
      const counts = await importMedia(pool, item, {});
      totalMedia += 1;
      totalCharacters += counts.characters;
    }

    if (onPage) {
      onPage({ page, count: media.length, totalMedia, totalCharacters, pageInfo });
    }

    if (!pageInfo.hasNextPage) break;
    if (maxPages !== null && pages >= maxPages) break;
    page += 1;
  }

  return { totalMedia, totalCharacters, pages };
}

/** Imports one or more media by AniList id (--ids mode). */
export async function importByIds(anilist, ids, {
  type = 'ANIME',
  charactersPerPage = 25,
  vaLanguage = 'JAPANESE',
  skipEpisodes = false,
} = {}) {
  const pool = getPool();
  let totalCharacters = 0;
  const results = [];

  for (const id of ids) {
    const variables = {
      id,
      type,
      charactersPage: 1,
      charactersPerPage,
      vaLanguage,
    };
    const data = await anilist.query(MEDIA_BY_ID_QUERY, variables);
    if (!data.Media) {
      console.warn(`[import] AniList has no ${type} with id ${id}; skipping`);
      continue;
    }
    const counts = await importMedia(pool, data.Media, { skipEpisodes });
    totalCharacters += counts.characters;
    results.push({ anilistId: id, ...counts });
  }

  return { results, totalCharacters };
}
