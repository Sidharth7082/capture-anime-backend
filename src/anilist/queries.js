// ============================================================================
// AniList GraphQL queries.
//
// The media field block is shared between the paginated catalog query and the
// single-id query, so both import paths produce identical data shapes.
//
// NOTE: the AniList public API does not expose per-episode metadata — Media
// only carries an `episodes` *count*. The importer therefore creates numbered
// episode placeholders (see importer.js); real episode titles/thumbnails must
// come from another source (e.g. AniDB scraping or manual curation).
// ============================================================================

export const MEDIA_FIELDS = /* GraphQL */ `
  id
  idMal
  type
  title {
    romaji
    english
    native
  }
  synonyms
  description
  format
  status
  episodes
  duration
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  averageScore
  meanScore
  popularity
  favourites
  source
  isAdult
  coverImage { extraLarge large medium color }
  bannerImage
  trailer { id site thumbnail }
  genres
  studios {
    edges {
      isMain
      node { id name isAnimationStudio }
    }
  }
  characters(page: $charactersPage, perPage: $charactersPerPage) {
    edges {
      role
      favouriteOrder
      node {
        id
        name { first last native full }
        image { large medium }
        description
        favourites
      }
      voiceActors(language: $vaLanguage) {
        id
        name { first last native full }
        image { large }
        languageV2
      }
    }
  }
`;

/** Paginated catalog query — the workhorse of a full or filtered import. */
export const PAGE_MEDIA_QUERY = /* GraphQL */ `
  query PageMedia(
    $page: Int
    $perPage: Int
    $type: MediaType
    $sort: [MediaSort]
    $season: MediaSeason
    $seasonYear: Int
    $format: MediaFormat
    $status: MediaStatus
    $isAdult: Boolean
    $charactersPage: Int
    $charactersPerPage: Int
    $vaLanguage: StaffLanguage
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        currentPage
        lastPage
        hasNextPage
      }
      media(
        type: $type
        sort: $sort
        season: $season
        seasonYear: $seasonYear
        format: $format
        status: $status
        isAdult: $isAdult
      ) {
        ${MEDIA_FIELDS}
      }
    }
  }
`;

/** Single-title import (--ids mode). */
export const MEDIA_BY_ID_QUERY = /* GraphQL */ `
  query MediaById(
    $id: Int
    $type: MediaType
    $charactersPage: Int
    $charactersPerPage: Int
    $vaLanguage: StaffLanguage
  ) {
    Media(id: $id, type: $type) {
      ${MEDIA_FIELDS}
    }
  }
`;
