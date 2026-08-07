/**
 * Jikan → platform normalizer (anime). Pure function, unit-tested.
 *
 * A different source (MAL user list, AniList, TMDB, ...) brings its own
 * normalizer; the rest of the pipeline is unchanged.
 */
import type {
  EnrichCharacter,
  EnrichPicture,
  EnrichRecommendation,
  EnrichRelation,
  EnrichStaffMember,
  EnrichVideo,
  EnrichVoiceActor,
  MetadataRef,
  NormalizedAnime,
  NormalizedAnimeEnrichment,
} from "./types.js";

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

/** Normalize an embedded MAL metadata array into unique MetadataRef[]. */function normalizeMetadata(refs: { mal_id?: number; name?: string }[] | null | undefined): MetadataRef[] {
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

// --- Stage 4 enrichment normalizer ------------------------------------------

/** Jikan shapes for the six detail endpoints (only the fields we consume). */
export interface JikanEnrichmentBundle {
  mal_id: number;
  failed_endpoints?: string[];
  characters?: JikanCharacterEntry[];
  staff?: JikanStaffEntry[];
  relations?: JikanRelationGroup[];
  recommendations?: JikanRecommendationEntry[];
  pictures?: JikanPicture[];
  videos?: { promo?: JikanPromoVideo[]; episodes?: JikanEpisodeVideo[] } | null;
}

interface JikanPerson {
  mal_id?: number;
  name?: string;
  images?: { jpg?: { image_url?: string | null } } | null;
}
interface JikanCharacterEntry {
  character?: JikanPerson & { name_kanji?: string | null };
  role?: string | null;
  favorites?: number | null;
  voice_actors?: { person?: JikanPerson; language?: string | null }[] | null;
}
interface JikanStaffEntry {
  person?: JikanPerson;
  positions?: string[] | null;
}
interface JikanRelationGroup {
  relation?: string | null;
  entry?: { mal_id?: number; type?: string | null; name?: string | null }[] | null;
}
interface JikanRecommendationEntry {
  entry?: { mal_id?: number; title?: string | null };
  votes?: number | null;
}
interface JikanPicture {
  jpg?: { image_url?: string | null; large_image_url?: string | null } | null;
  webp?: { image_url?: string | null } | null;
}
interface JikanPromoVideo {
  title?: string | null;
  trailer?: { youtube_id?: string | null; url?: string | null; embed_url?: string | null; images?: { maximum_image_url?: string | null; large_image_url?: string | null; medium_image_url?: string | null } | null } | null;
}
interface JikanEpisodeVideo {
  mal_id?: number;
  title?: string | null;
  episode?: string | null;
  url?: string | null;
  images?: { jpg?: { image_url?: string | null } } | null;
}

/** "Last, First" -> { first, last }; anything else -> { first: full, last: null }. */
function splitName(name: string): { first: string; last: string | null } {
  const comma = name.indexOf(", ");
  if (comma > 0) {
    const first = name.slice(comma + 2).trim();
    const last = name.slice(0, comma).trim();
    return { first: first || name, last: last || null };
  }
  return { first: name.trim(), last: null };
}

function mapRole(role: string | null | undefined): EnrichCharacter["role"] {
  const upper = role?.toUpperCase();
  if (upper === "MAIN") return "MAIN";
  if (upper === "SUPPORTING") return "SUPPORTING";
  return "BACKGROUND";
}

function mapVoiceActors(entry: JikanCharacterEntry | undefined | null): EnrichVoiceActor[] {
  if (!entry?.voice_actors) return [];
  const seen = new Set<number>();
  const out: EnrichVoiceActor[] = [];
  for (const va of entry.voice_actors) {
    const malId = va.person?.mal_id;
    const name = va.person?.name;
    if (malId == null || !name || seen.has(malId)) continue;
    seen.add(malId);
    out.push({
      malId,
      name,
      imageUrl: va.person?.images?.jpg?.image_url ?? null,
      language: va.language ?? null,
    });
  }
  return out;
}

/** Map one anime's six Jikan detail payloads into a normalized enrichment bundle. */
export function normalizeAnimeEnrichment(bundle: JikanEnrichmentBundle): NormalizedAnimeEnrichment {
  const characters: EnrichCharacter[] = [];
  const seenChars = new Set<number>();
  for (const [index, entry] of (bundle.characters ?? []).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const char = entry.character;
    if (!char?.mal_id || !char.name || seenChars.has(char.mal_id)) continue;
    seenChars.add(char.mal_id);
    const { first, last } = splitName(char.name);
    characters.push({
      malId: char.mal_id,
      name: char.name,
      nameKanji: char.name_kanji ?? null,
      imageUrl: char.images?.jpg?.image_url ?? null,
      role: mapRole(entry.role),
      sortOrder: index,
      voiceActors: mapVoiceActors(entry),
    });
  }

  const staff: EnrichStaffMember[] = [];
  const seenStaff = new Set<number>();
  for (const entry of bundle.staff ?? []) {
    const person = entry.person;
    if (!person?.mal_id || !person.name || seenStaff.has(person.mal_id)) continue;
    seenStaff.add(person.mal_id);
    staff.push({
      malId: person.mal_id,
      name: person.name,
      imageUrl: person.images?.jpg?.image_url ?? null,
      positions: Array.isArray(entry.positions) ? entry.positions.filter(Boolean) : [],
    });
  }

  const relations: EnrichRelation[] = [];
  for (const group of bundle.relations ?? []) {
    const relation = group.relation?.trim() ?? "Other";
    for (const entry of group.entry ?? []) {
      if (entry.mal_id == null || !entry.name) continue;
      relations.push({
        malId: entry.mal_id,
        mediaType: entry.type ?? "unknown",
        name: entry.name,
        relation,
      });
    }
  }

  const recommendations: EnrichRecommendation[] = [];
  for (const entry of bundle.recommendations ?? []) {
    if (entry.entry?.mal_id == null || !entry.entry.title) continue;
    recommendations.push({
      malId: entry.entry.mal_id,
      title: entry.entry.title,
      votes: entry.votes != null ? Math.max(0, entry.votes) : 0,
    });
  }

  const pictures: EnrichPicture[] = [];
  for (const picture of bundle.pictures ?? []) {
    const imageUrl = picture.jpg?.image_url;
    if (!imageUrl) continue;
    pictures.push({
      imageUrl,
      largeImageUrl: picture.jpg?.large_image_url ?? null,
      webpUrl: picture.webp?.image_url ?? null,
    });
  }

  const videos: EnrichVideo[] = [];
  for (const [index, promo] of (bundle.videos?.promo ?? []).entries()) {
    const title = promo.title?.trim() || `Promo ${index + 1}`;
    videos.push({
      kind: "promo",
      title,
      youtubeId: promo.trailer?.youtube_id ?? null,
      url: promo.trailer?.url ?? null,
      embedUrl: promo.trailer?.embed_url ?? null,
      thumbnailLarge:
        promo.trailer?.images?.maximum_image_url ?? promo.trailer?.images?.large_image_url ?? promo.trailer?.images?.medium_image_url ?? null,
      episodeNumber: null,
    });
  }
  for (const episode of bundle.videos?.episodes ?? []) {
    const num = /^Episode\s+(\d+)/.exec(episode.episode ?? "");
    videos.push({
      kind: "episode",
      title: episode.title?.trim() || `Episode ${episode.episode ?? ""}`.trim(),
      youtubeId: null,
      url: episode.url ?? null,
      embedUrl: null,
      thumbnailLarge: episode.images?.jpg?.image_url ?? null,
      episodeNumber: num ? Number(num[1]) : null,
    });
  }

  return {
    idMal: bundle.mal_id,
    failedEndpoints: bundle.failed_endpoints ?? [],
    characters,
    staff,
    relations,
    recommendations,
    pictures,
    videos,
  };
}

// --- URL slug -----------------------------------------------------------------

/**
 * Build a URL slug from a title. Pure + deterministic: kebab-cased romaji/
 * english title, `anime-{malId}` when there is no usable title. Uniqueness
 * is guaranteed by the upsert appending `-{malId}` on collision.
 */
export function makeSlug(title: string | null | undefined, idMal: number): string {
  const base = title
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return (base && base.length > 0 ? base : `anime-${idMal}`).slice(0, 120);
}

// --- AniList canonical normalizer --------------------------------------------

/** AniList Media shape (the fields we consume; enums match the DB exactly). */
export interface AniListMedia {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: string[] | null;
  description?: string | null; // HTML, AniList-style
  format?: string | null; // TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA | MUSIC
  status?: string | null; // FINISHED | RELEASING | NOT_YET_RELEASED | CANCELLED | HIATUS
  episodes?: number | null;
  duration?: number | null; // minutes per episode
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  season?: string | null; // WINTER | SPRING | SUMMER | FALL
  seasonYear?: number | null;
  averageScore?: number | null; // 0..100
  meanScore?: number | null; // 0..100
  popularity?: number | null;
  favourites?: number | null;
  source?: string | null; // matches media_source enum
  isAdult?: boolean | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
    medium?: string | null;
    color?: string | null;
  } | null;
  bannerImage?: string | null;
  trailer?: { id?: string | null; site?: string | null; thumbnail?: string | null } | null;
  genres?: string[] | null;
  studios?: {
    nodes?: Array<{ id?: number | null; name?: string | null; isAnimationStudio?: boolean | null } | null> | null;
  } | null;
  nextAiringEpisode?: { airingAt?: number | null; episode?: number | null } | null;
  /** AniList updatedAt (epoch) — used by the incremental cursor. */
  updatedAt?: number | null;
}

function anilistDate(d: AniListMedia["startDate"]): string | null {
  if (!d?.year) return null;
  const month = d.month != null ? String(d.month).padStart(2, "0") : "01";
  const day = d.day != null ? String(d.day).padStart(2, "0") : "01";
  return `${d.year}-${month}-${day}`;
}

function anilistScore(score: number | null | undefined): number | null {
  if (score == null) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Map one AniList Media item into the canonical platform row. */
export function normalizeAniListItem(media: AniListMedia): NormalizedAnime {
  return {
    idMal: media.idMal ?? null,
    titleRomaji: media.title?.romaji ?? null,
    titleEnglish: media.title?.english ?? null,
    titleNative: media.title?.native ?? null,
    synonyms: Array.isArray(media.synonyms) ? media.synonyms.filter(Boolean) : [],
    description: media.description ?? null,
    format: media.format ?? null,
    status: media.status ?? null,
    episodes: media.episodes != null ? Math.max(0, media.episodes) : null,
    durationMinutes: media.duration != null ? Math.max(0, media.duration) : null,
    startDate: anilistDate(media.startDate),
    endDate: anilistDate(media.endDate),
    season: media.season ?? null,
    seasonYear: media.seasonYear != null ? Math.max(1917, Math.min(2100, media.seasonYear)) : null,
    averageScore: anilistScore(media.averageScore),
    meanScore: anilistScore(media.meanScore),
    popularity: media.popularity != null ? Math.max(0, media.popularity) : null,
    favourites: media.favourites != null ? Math.max(0, media.favourites) : null,
    source: media.source ?? null,
    isAdult: media.isAdult ?? false,
    coverImageLarge: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    coverImageMedium: media.coverImage?.medium ?? media.coverImage?.large ?? null,
    genres: (media.genres ?? [])
      .filter((g): g is string => typeof g === "string" && g.length > 0)
      .map((name) => ({ name } as MetadataRef)), // AniList genres carry no MAL id
    themes: [],
    demographics: [],
    studios: (media.studios?.nodes ?? [])
      .filter((s): s is { id: number; name: string; isAnimationStudio?: boolean | null } => !!s && s.id != null && !!s.name)
      .map((s) => ({ malId: s.id, name: s.name, isAnimationStudio: s.isAnimationStudio ?? false })),
    producers: [],
    licensors: [],
    anilistId: media.id,
    bannerImage: media.bannerImage ?? null,
    coverImageColor: media.coverImage?.color ?? null,
    trailerId: media.trailer?.id ?? null,
    trailerSite: media.trailer?.site ?? null,
    trailerThumbnail: media.trailer?.thumbnail ?? null,
    nextAiringAt: media.nextAiringEpisode?.airingAt != null ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString() : null,
  };
}
