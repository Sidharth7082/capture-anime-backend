/**
 * Jikan → platform normalizer (anime). Pure function, unit-tested.
 *
 * A different source (MAL user list, AniList, TMDB, ...) brings its own
 * normalizer; the rest of the pipeline is unchanged.
 */
import type { MetadataRef, NormalizedAnime } from "./types.js";

/** Jikan anime shape (only the fields Stage 1 consumes). */
export interface JikanAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  title_synonyms?: string[] | null;
  type?: string | null;
  source?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: string | null;
  rating?: string | null;
  score?: number | null;
  members?: number | null;
  favorites?: number | null;
  season?: string | null;
  year?: number | null;
  synopsis?: string | null;
  aired?: { from?: string | null; to?: string | null } | null;
  images?: {
    jpg?: {
      image_url?: string | null;
      small_image_url?: string | null;
      medium_image_url?: string | null;
      large_image_url?: string | null;
    };
    webp?: { large_image_url?: string | null; medium_image_url?: string | null };
  } | null;
  genres?: { mal_id?: number; name?: string }[] | null;
  themes?: { mal_id?: number; name?: string }[] | null;
  demographics?: { mal_id?: number; name?: string }[] | null;
  studios?: { mal_id?: number; name?: string }[] | null;
  producers?: { mal_id?: number; name?: string }[] | null;
  licensors?: { mal_id?: number; name?: string }[] | null;
}

// --- enum mappings (Jikan string -> platform enum) --------------------------

const FORMAT_MAP: Record<string, string> = {
  TV: "TV",
  Movie: "MOVIE",
  OVA: "OVA",
  ONA: "ONA",
  Special: "SPECIAL",
  Music: "MUSIC",
};

const STATUS_MAP: Record<string, string> = {
  "Finished Airing": "FINISHED",
  "Currently Airing": "RELEASING",
  "Not yet aired": "NOT_YET_RELEASED",
};

const SOURCE_MAP: Record<string, string> = {
  Original: "ORIGINAL",
  Manga: "MANGA",
  "Light novel": "LIGHT_NOVEL",
  "Visual novel": "VISUAL_NOVEL",
  "Video game": "VIDEO_GAME",
  Other: "OTHER",
  Novel: "NOVEL",
  Doujinshi: "DOUJINSHI",
  Anime: "ANIME",
  "Web novel": "WEB_NOVEL",
  "Live action": "LIVE_ACTION",
  Game: "GAME",
  Comic: "COMIC",
  "Multimedia project": "MULTIMEDIA_PROJECT",
  "Picture book": "PICTURE_BOOK",
};

const SEASONS = new Set(["WINTER", "SPRING", "SUMMER", "FALL"]);
const MIN_YEAR = 1917;
const MAX_YEAR = 2100;

function datePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

function parseDurationMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const match = /(\d+)\s*min/.exec(duration);
  return match ? Number(match[1]) : null;
}

/** Normalize an embedded MAL metadata array into unique MetadataRef[]. */
function normalizeMetadata(refs: { mal_id?: number; name?: string }[] | null | undefined): MetadataRef[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<number>();
  const out: MetadataRef[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    if (ref.mal_id == null || !ref.name || seen.has(ref.mal_id)) continue;
    seen.add(ref.mal_id);
    out.push({ malId: ref.mal_id, name: ref.name });
  }
  return out;
}

/** Map a Jikan list item into the platform `anime` row shape. */
export function normalizeAnimeItem(item: JikanAnime): NormalizedAnime {
  const score = item.score != null ? Math.max(0, Math.min(100, Math.round(item.score * 10))) : null;

  let endDate = datePart(item.aired?.to);
  const startDate = datePart(item.aired?.from);
  if (startDate && endDate && endDate < startDate) {
    endDate = null; // satisfy anime_dates_check (end >= start)
  }

  const rawSeason = item.season?.toUpperCase() ?? null;
  const season = rawSeason && SEASONS.has(rawSeason) ? rawSeason : null;
  const year = item.year != null && item.year >= MIN_YEAR && item.year <= MAX_YEAR ? item.year : null;

  return {
    idMal: item.mal_id,
    titleRomaji: item.title ?? null,
    titleEnglish: item.title_english ?? null,
    titleNative: item.title_japanese ?? null,
    synonyms: Array.isArray(item.title_synonyms) ? item.title_synonyms.filter(Boolean) : [],
    description: item.synopsis ?? null,
    format: item.type ? (FORMAT_MAP[item.type] ?? null) : null,
    status: item.status ? (STATUS_MAP[item.status] ?? null) : null,
    episodes: item.episodes != null ? Math.max(0, item.episodes) : null,
    durationMinutes: parseDurationMinutes(item.duration),
    startDate,
    endDate,
    season,
    seasonYear: year,
    averageScore: score,
    meanScore: score,
    popularity: item.members != null ? Math.max(0, item.members) : null,
    favourites: item.favorites != null ? Math.max(0, item.favorites) : null,
    source: item.source ? (SOURCE_MAP[item.source] ?? null) : null,
    isAdult: item.rating?.startsWith("Rx") ?? false,
    coverImageLarge: item.images?.jpg?.large_image_url ?? item.images?.webp?.large_image_url ?? null,
    coverImageMedium: item.images?.jpg?.medium_image_url ?? item.images?.webp?.medium_image_url ?? item.images?.jpg?.image_url ?? null,
    genres: normalizeMetadata(item.genres),
    themes: normalizeMetadata(item.themes),
    demographics: normalizeMetadata(item.demographics),
    studios: normalizeMetadata(item.studios),
    producers: normalizeMetadata(item.producers),
    licensors: normalizeMetadata(item.licensors),
  };
}
