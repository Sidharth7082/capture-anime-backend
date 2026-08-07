/**
 * Pipeline contracts — the pieces every import source reuses.
 *
 * A new data source (MAL user lists, AniList, TMDB, MangaDex, Kitsu, ...)
 * only has to provide a Fetcher and a Normalizer; Validator, UpsertService,
 * JobStore and the Typesense Sink stay the same for every source.
 */

// --- fetch ------------------------------------------------------------------

export interface FetchedPage<T> {
  items: T[];
  hasNextPage: boolean;
}

export interface Fetcher<T> {
  /** Stable identifier used for job bookkeeping (e.g. 'jikan-anime'). */
  readonly source: string;
  /** Fetch one page of raw records. */
  fetchPage(page: number): Promise<FetchedPage<T>>;
}

// --- normalize / validate ----------------------------------------------------

export type Normalizer<T, R> = (raw: T) => R;

export type ValidationResult<R> =
  | { ok: true; row: R }
  | { ok: false; reason: string };

export type Validator<R> = (row: R) => ValidationResult<R>;

// --- write -------------------------------------------------------------------

/** Database write port (PostgreSQL today, anything later). */
export interface UpsertPort<R> {
  /** Insert or update one normalized row. Returns what happened. */
  upsert(row: R): Promise<"inserted" | "updated">;
}

/** Final sink after a successful import (Typesense today, no-op when off). */
export interface Sink<R> {
  ingest(rows: R[]): Promise<void>;
}

// --- resume bookkeeping ------------------------------------------------------

export type JobStatus = "running" | "completed" | "failed";

export interface JobStore {
  /** Last completed page for a source (0 when never run). */
  getResumePage(source: string): Promise<number>;
  /** Mark the source as running (starts the clock on first run). */
  markStarted(source: string, resumePage: number): Promise<void>;
  /** Persist progress after a completed page (the resume point). */
  markPage(source: string, page: number, totalItems: number): Promise<void>;
  /** Final state + duration on success/failure/cancel. */
  markFinished(source: string, status: "completed" | "failed", error?: string | null): Promise<void>;
}

// --- runner ------------------------------------------------------------------

export interface RunCounters {
  fetched: number;
  inserted: number;
  updated: number;
  failed: number;
}

export interface RunResult extends RunCounters {
  ok: boolean;
  summary: string;
}

export interface PipelineOptions {
  /** Resume from last_page + 1 by default; true forces a clean start at 1. */
  reset?: boolean;
  /** Override the resume page (advanced use). */
  startPage?: number;
  /** Stop after this many items. */
  limit?: number;
  /** Stop after this many pages (relative to the start page). */
  maxPages?: number;
  /** Fetch + normalize + validate only — no writes. */
  dryRun?: boolean;
}

export interface PipelineDeps<T, R> {
  source: string;
  fetcher: Fetcher<T>;
  normalizer: Normalizer<T, R>;
  validator: Validator<R>;
  upsert: UpsertPort<R>;
  jobs: JobStore;
  sink: Sink<R>;
  pageDelayMs?: number;
  isCancelled?: () => boolean;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

// --- normalized anime row (platform schema) ----------------------------------

/** A MAL metadata reference embedded in Jikan anime items. */
export interface MetadataRef {
  malId: number;
  name: string;
}

// --- Stage 4 enrichment (per-anime detail data) -----------------------------

export interface EnrichVoiceActor {
  malId: number;
  name: string;
  imageUrl: string | null;
  /** Dub language, e.g. "Japanese" / "English". */
  language: string | null;
}

export interface EnrichCharacter {
  malId: number;
  name: string;
  nameKanji: string | null;
  imageUrl: string | null;
  role: "MAIN" | "SUPPORTING" | "BACKGROUND";
  sortOrder: number;
  voiceActors: EnrichVoiceActor[];
}

export interface EnrichStaffMember {
  malId: number;
  name: string;
  imageUrl: string | null;
  positions: string[];
}

export interface EnrichRelation {
  malId: number;
  mediaType: string; // 'anime' | 'manga' | ...
  name: string;
  relation: string; // 'Sequel' | 'Prequel' | ...
}

export interface EnrichRecommendation {
  malId: number;
  title: string;
  votes: number;
}

export interface EnrichPicture {
  imageUrl: string;
  largeImageUrl: string | null;
  webpUrl: string | null;
}

export interface EnrichVideo {
  kind: "promo" | "episode";
  title: string;
  youtubeId: string | null;
  url: string | null;
  embedUrl: string | null;
  thumbnailLarge: string | null;
  episodeNumber: number | null;
}

/** Normalized enrichment bundle for one anime (all six detail endpoints). */
export interface NormalizedAnimeEnrichment {
  idMal: number;
  /** Endpoints that failed to fetch for this anime ('' when all succeeded). */
  failedEndpoints: string[];
  characters: EnrichCharacter[];
  staff: EnrichStaffMember[];
  relations: EnrichRelation[];
  recommendations: EnrichRecommendation[];
  pictures: EnrichPicture[];
  videos: EnrichVideo[];
}

/** Normalized row matching the `anime` table columns (Stage 1 subset). */
export interface NormalizedAnime {
  idMal: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  synonyms: string[];
  description: string | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  durationMinutes: number | null;
  startDate: string | null;
  endDate: string | null;
  season: string | null;
  seasonYear: number | null;
  averageScore: number | null;
  meanScore: number | null;
  popularity: number | null;
  favourites: number | null;
  source: string | null;
  isAdult: boolean;
  coverImageLarge: string | null;
  coverImageMedium: string | null;
  /** Stage 2 metadata (embedded in Jikan list items). */
  genres: MetadataRef[];
  themes: MetadataRef[];
  demographics: MetadataRef[];
  studios: MetadataRef[];
  producers: MetadataRef[];
  licensors: MetadataRef[];
}
