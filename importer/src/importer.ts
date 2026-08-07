/**
 * Import orchestrator.
 *
 * STAGE 1 — ANIME ONLY: fetch the full Jikan catalogue page by page, normalize
 * each title into the platform's `anime` table and upsert by MAL id
 * (`anime.id_mal`). Characters, episodes, studios, genres, relations,
 * themes, pictures, trailers and Typesense are intentionally NOT touched yet.
 */
import type { JikanClient } from "./jikan.js";
import type { Database } from "./database.js";
import type { TypesenseClient } from "./typesense.js";

export interface ImportDeps {
  jikan: JikanClient;
  db: Database;
  typesense: TypesenseClient;
  /** Polite delay between page requests (0 to disable). */
  pageDelayMs?: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface ImportResult {
  ok: boolean;
  /** Rows inserted (new MAL ids). */
  imported: number;
  /** Rows updated (existing MAL ids). */
  updated: number;
  /** Items that failed to normalize/upsert. */
  failed: number;
  /** Total items fetched from Jikan. */
  fetched: number;
  /** Human-readable summary for logs. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Jikan anime shape (only the fields Stage 1 consumes)
// ---------------------------------------------------------------------------
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
  };
}

// ---------------------------------------------------------------------------
// SQL (upsert by MAL id inside a per-row transaction)
// ---------------------------------------------------------------------------

// Columns populated by Stage 1. `media_type` keeps its default 'ANIME';
// trailers/pictures/color stay NULL until their stages land.
const ANIME_COLUMNS = [
  "id_mal",
  "title_romaji",
  "title_english",
  "title_native",
  "synonyms",
  "description",
  "format",
  "status",
  "episodes",
  "duration_minutes",
  "start_date",
  "end_date",
  "season",
  "season_year",
  "average_score",
  "mean_score",
  "popularity",
  "favourites",
  "source",
  "is_adult",
  "cover_image_large",
  "cover_image_medium",
] as const;

type AnimeColumn = (typeof ANIME_COLUMNS)[number];

const COLUMN_SET_CLAUSE = ANIME_COLUMNS.map((col, i) => `${col} = $${i + 1}`).join(", ");

function rowValues(row: NormalizedAnime): unknown[] {
  return [
    row.idMal,
    row.titleRomaji,
    row.titleEnglish,
    row.titleNative,
    row.synonyms,
    row.description,
    row.format,
    row.status,
    row.episodes,
    row.durationMinutes,
    row.startDate,
    row.endDate,
    row.season,
    row.seasonYear,
    row.averageScore,
    row.meanScore,
    row.popularity,
    row.favourites,
    row.source,
    row.isAdult,
    row.coverImageLarge,
    row.coverImageMedium,
  ];
}

export class Importer {
  private readonly deps: ImportDeps;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;
  private cancelled = false;

  constructor(deps: ImportDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? console;
  }

  /** Ask a running import to stop at the next safe boundary (page/item). */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * STAGE 1: import the anime catalogue.
   * Sequential pages; per-row transaction; idempotent upsert by mal_id.
   */
  async importAnime(options: { limit?: number; maxPages?: number; dryRun?: boolean } = {}): Promise<ImportResult> {
    const { limit, maxPages, dryRun = false } = options;
    this.cancelled = false;

    const counts = { imported: 0, updated: 0, failed: 0, fetched: 0 };
    let page = 1;
    let limitReached = false;

    for (;;) {
      if (this.cancelled) {
        this.logger.warn("[anime] import cancelled by signal");
        break;
      }
      if (maxPages != null && page > maxPages) break;

      let response: { data: JikanAnime[]; pagination?: { has_next_page?: boolean } };
      try {
        response = await this.deps.jikan.getJson("/v4/anime", { page });
      } catch (err) {
        // Page failed after retries — stop the run, it can resume on the
        // next scheduled pass (upserts are idempotent).
        this.logger.error(`[anime] page ${page} failed after retries: ${String(err)}`);
        counts.failed += 1;
        break;
      }

      const items = response.data ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (this.cancelled) break;
        if (limit != null && counts.fetched >= limit) {
          limitReached = true;
          break;
        }
        counts.fetched += 1;

        try {
          const row = normalizeAnimeItem(item);
          if (dryRun) {
            counts.updated += 1; // would-upsert; exact insert/update unknown without DB
            continue;
          }
          const outcome = await this.upsertAnime(row);
          if (outcome === "inserted") counts.imported += 1;
          else counts.updated += 1;
        } catch (err) {
          counts.failed += 1;
          this.logger.error(`[anime] failed mal_id=${item.mal_id} (${item.title}): ${String(err)}`);
        }
      }

      this.logger.info(
        `[anime] page ${page}: +${counts.imported} inserted / ~${counts.updated} updated / !${counts.failed} failed (${counts.fetched} fetched${dryRun ? " [dry-run]" : ""})`,
      );

      if (limitReached || !response.pagination?.has_next_page) break;
      page += 1;
      if (this.deps.pageDelayMs) await delay(this.deps.pageDelayMs);
    }

    const summary = `anime: ${counts.imported} inserted, ${counts.updated} updated, ${counts.failed} failed, ${counts.fetched} fetched (${limitReached ? "limit" : this.cancelled ? "cancelled" : "complete"}${dryRun ? ", dry-run" : ""})`;
    return { ok: counts.failed === 0, ...counts, summary };
  }

  /** Upsert one anime by mal_id (atomic). Returns 'inserted' | 'updated'. */
  private async upsertAnime(row: NormalizedAnime): Promise<"inserted" | "updated"> {
    return this.deps.db.transaction(async (client) => {
      const existing = await client.query<{ id: number }>(
        "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
        [row.idMal],
      );

      if (existing.rows[0]) {
        const params = [...rowValues(row), existing.rows[0].id];
        await client.query(
          `UPDATE anime SET ${COLUMN_SET_CLAUSE}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
        return "updated" as const;
      }

      await client.query(
        `INSERT INTO anime (anilist_id, ${ANIME_COLUMNS.join(", ")})
         VALUES (NULL, ${ANIME_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
        rowValues(row),
      );
      return "inserted" as const;
    });
  }

  /**
   * Scheduled entrypoint (called by the scheduler). Currently runs the anime
   * import; later stages compose on top of it.
   */
  async run(): Promise<ImportResult> {
    return this.importAnime();
  }
}

export function createImporter(deps: ImportDeps): Importer {
  return new Importer(deps);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
