/**
 * Database write layer. Implements UpsertPort<NormalizedAnime> by upserting
 * against the platform `anime` table inside a per-row transaction.
 *
 * Future stages add more methods here (upsertGenre, upsertStudio, ...) or
 * new ports for other tables — the pipeline itself doesn't change.
 */
import type { Database } from "../database.js";
import type { NormalizedAnime, UpsertPort } from "./types.js";

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

export class AnimeUpsertService implements UpsertPort<NormalizedAnime> {
  constructor(private readonly db: Database) {}

  /** Upsert one anime by mal_id (atomic). Returns 'inserted' | 'updated'. */
  async upsert(row: NormalizedAnime): Promise<"inserted" | "updated"> {
    return this.db.transaction(async (client) => {
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
}

export function createAnimeUpsertService(db: Database): AnimeUpsertService {
  return new AnimeUpsertService(db);
}
