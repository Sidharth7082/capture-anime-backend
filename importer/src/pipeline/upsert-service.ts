/**
 * Database write layer. Implements UpsertPort<NormalizedAnime> by upserting
 * against the platform `anime` table AND its metadata (genres, studios,
 * producers, licensors, themes, demographics) inside one per-row transaction.
 *
 * The metadata resolution is idempotent: rows are matched by MAL id first,
 * then by name (links AniList-imported rows that have no MAL id), else
 * inserted. Stale join rows are pruned so the DB mirrors Jikan exactly.
 */
import type { Database } from "../database.js";
import type { MetadataRef, NormalizedAnime, UpsertPort } from "./types.js";

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

/** Which join column links a metadata table back to its anime. */
interface MetadataTable {
  table: string;
  joinTable: string;
  joinColumn: string;
}

type MetadataKey = "genres" | "studios" | "producers" | "licensors" | "themes" | "demographics";

const METADATA_TABLES: Record<MetadataKey, MetadataTable> = {
  genres: { table: "genres", joinTable: "anime_genres", joinColumn: "genre_id" },
  studios: { table: "studios", joinTable: "anime_studios", joinColumn: "studio_id" },
  producers: { table: "producers", joinTable: "anime_producers", joinColumn: "producer_id" },
  licensors: { table: "licensors", joinTable: "anime_licensors", joinColumn: "licensor_id" },
  themes: { table: "themes", joinTable: "anime_themes", joinColumn: "theme_id" },
  demographics: { table: "demographics", joinTable: "anime_demographics", joinColumn: "demographic_id" },
};

/** Minimal query surface the metadata writer needs (same shape as `pg`). */
interface Queryable {
  query<T = { id: number }>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Resolve (or create) one metadata row; returns its local id. */
async function resolveMetadataId(
  client: Queryable,
  table: string,
  ref: MetadataRef,
): Promise<number> {
  // 1) by MAL id
  const byMal = await client.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE mal_id = $1 LIMIT 1`,
    [ref.malId],
  );
  const byMalId = byMal.rows[0];
  if (byMalId) return byMalId.id;

  // 2) by name (links rows imported without a MAL id, e.g. from AniList)
  const byName = await client.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE name = $1 LIMIT 1`,
    [ref.name],
  );
  const byNameId = byName.rows[0];
  if (byNameId) {
    await client.query(`UPDATE ${table} SET mal_id = $1 WHERE id = $2`, [ref.malId, byNameId.id]);
    return byNameId.id;
  }

  // 3) create
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO ${table} (mal_id, name) VALUES ($1, $2) RETURNING id`,
    [ref.malId, ref.name],
  );
  return inserted.rows[0]!.id;
}

export class AnimeUpsertService implements UpsertPort<NormalizedAnime> {
  constructor(private readonly db: Database) {}

  /** Upsert one anime + its metadata by mal_id (atomic). Returns 'inserted' | 'updated'. */
  async upsert(row: NormalizedAnime): Promise<"inserted" | "updated"> {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{ id: number }>(
        "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
        [row.idMal],
      );
      const existingRow = existing.rows[0];

      let animeId: number;
      let outcome: "inserted" | "updated";

      if (existingRow) {
        const params = [...rowValues(row), existingRow.id];
        await client.query(
          `UPDATE anime SET ${COLUMN_SET_CLAUSE}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
        animeId = existingRow.id;
        outcome = "updated";
      } else {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO anime (anilist_id, ${ANIME_COLUMNS.join(", ")})
           VALUES (NULL, ${ANIME_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
          rowValues(row),
        );
        animeId = inserted.rows[0]!.id;
        outcome = "inserted";
      }

      await this.writeMetadata(client, animeId, row);
      return outcome;
    });
  }

  /** Write all six metadata groups + join rows for one anime (caller holds the txn). */
  private async writeMetadata(
    client: Queryable,
    animeId: number,
    row: NormalizedAnime,
  ): Promise<void> {
    const groups: [MetadataTable, MetadataRef[]][] = [
      [METADATA_TABLES.genres, row.genres],
      [METADATA_TABLES.studios, row.studios],
      [METADATA_TABLES.producers, row.producers],
      [METADATA_TABLES.licensors, row.licensors],
      [METADATA_TABLES.themes, row.themes],
      [METADATA_TABLES.demographics, row.demographics],
    ];

    for (const [spec, refs] of groups) {
      const ids: number[] = [];
      for (const ref of refs) {
        const id = await resolveMetadataId(client, spec.table, ref);
        ids.push(id);
        await client.query(
          `INSERT INTO ${spec.joinTable} (anime_id, ${spec.joinColumn}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [animeId, id],
        );
      }

      // Prune joins Jikan no longer lists (authoritative per anime).
      if (ids.length > 0) {
        await client.query(
          `DELETE FROM ${spec.joinTable} WHERE anime_id = $1 AND ${spec.joinColumn} NOT IN (${ids
            .map((_, i) => `$${i + 2}`)
            .join(", ")})`,
          [animeId, ...ids],
        );
      } else {
        await client.query(`DELETE FROM ${spec.joinTable} WHERE anime_id = $1`, [animeId]);
      }
    }
  }
}

export function createAnimeUpsertService(db: Database): AnimeUpsertService {
  return new AnimeUpsertService(db);
}
