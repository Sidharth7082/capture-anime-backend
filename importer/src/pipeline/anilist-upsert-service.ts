/**
 * AniList canonical write layer.
 *
 * AniList is the source of truth for the anime ROW: it brings the
 * AniList-specific fields (banner, cover color, trailer, mean score, next
 * airing) and matches the existing catalog by **anilist_id first, then by
 * id_mal** — so it UPDATES rows created by the Jikan importer (filling in
 * their anilist_id) instead of ever inserting a duplicate. Rows AniList
 * doesn't know (no MAL entry) are inserted with only an anilist_id.
 *
 * Genres are matched by NAME (AniList genres carry no MAL id); studios are
 * matched by AniList id. Everything happens in one per-row transaction.
 */
import type { Database } from "../database.js";
import type { MetadataRef, NormalizedAnime, UpsertPort } from "./types.js";
import { makeSlug } from "./normalizers.js";

interface Queryable {
  query<T = { id: number }>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const COLUMNS = [
  "id_mal",
  "anilist_id",
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
  "cover_image_color",
  "banner_image",
  "trailer_id",
  "trailer_site",
  "trailer_thumbnail",
  "next_airing_at",
] as const;

function rowValues(row: NormalizedAnime): unknown[] {
  return [
    row.idMal,
    row.anilistId ?? null,
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
    row.meanScore ?? null,
    row.popularity,
    row.favourites,
    row.source,
    row.isAdult,
    row.coverImageLarge,
    row.coverImageMedium,
    row.coverImageColor ?? null,
    row.bannerImage ?? null,
    row.trailerId ?? null,
    row.trailerSite ?? null,
    row.trailerThumbnail ?? null,
    row.nextAiringAt ?? null,
  ];
}

/** Resolve a genre by name (genres.name is UNIQUE); insert when unknown. */
async function resolveGenreId(client: Queryable, name: string): Promise<number> {
  const hit = await client.query<{ id: number }>("SELECT id FROM genres WHERE name = $1 LIMIT 1", [name]);
  if (hit.rows[0]) return hit.rows[0].id;
  const inserted = await client.query<{ id: number }>(
    "INSERT INTO genres (name) VALUES ($1) RETURNING id",
    [name],
  );
  return inserted.rows[0]!.id;
}

/** Resolve a studio by AniList id (falls back to name, then insert). */
async function resolveStudioId(
  client: Queryable,
  s: { id?: number | null; name?: string | null; isAnimationStudio?: boolean | null },
): Promise<number> {
  if (s.id != null && s.name != null) {
    const byId = await client.query<{ id: number }>(
      "SELECT id FROM studios WHERE anilist_id = $1 LIMIT 1",
      [s.id],
    );
    if (byId.rows[0]) {
      await client.query(
        `UPDATE studios SET name = $2, is_animation_studio = $3, updated_at = now(), last_synced_at = now() WHERE id = $1`,
        [byId.rows[0].id, s.name, s.isAnimationStudio ?? false],
      );
      return byId.rows[0].id;
    }
    const byName = await client.query<{ id: number }>(
      "SELECT id FROM studios WHERE name = $1 LIMIT 1",
      [s.name],
    );
    if (byName.rows[0]) {
      await client.query(
        `UPDATE studios SET anilist_id = $2, is_animation_studio = $3, updated_at = now(), last_synced_at = now() WHERE id = $1`,
        [byName.rows[0].id, s.id, s.isAnimationStudio ?? false],
      );
      return byName.rows[0].id;
    }
  }
  const name = s.name ?? `studio-${s.id ?? "unknown"}`;
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO studios (anilist_id, name, is_animation_studio) VALUES ($1, $2, $3) RETURNING id`,
    [s.id ?? null, name, s.isAnimationStudio ?? false],
  );
  return inserted.rows[0]!.id;
}

export class AniListUpsertService implements UpsertPort<NormalizedAnime> {
  constructor(private readonly db: Database) {}

  /** Upsert one canonical anime row (match anilist_id, then id_mal). */
  async upsert(row: NormalizedAnime): Promise<"inserted" | "updated"> {
    if (row.anilistId == null) return "updated" as const; // nothing to match on
    return this.db.transaction(async (client) => {
      // 1) match by AniList id (the canonical key)
      const byAnilist = await client.query<{ id: number }>(
        "SELECT id FROM anime WHERE anilist_id = $1 ORDER BY id LIMIT 1",
        [row.anilistId],
      );
      // 2) match by MAL id (links rows created by the Jikan importer)
      let animeRow = byAnilist.rows[0];
      if (!animeRow && row.idMal != null) {
        const byMal = await client.query<{ id: number }>(
          "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
          [row.idMal],
        );
        animeRow = byMal.rows[0];
      }

      let animeId: number;
      let outcome: "inserted" | "updated";

      if (animeRow) {
        const params = [...rowValues(row), animeRow.id];
        const setClause = COLUMNS.map((col, i) => `${col} = $${i + 1}`).join(", ");
        await client.query(
          `UPDATE anime SET ${setClause},
             slug = CASE WHEN slug IS NULL OR slug = 'anime-' || anime.id_mal::text THEN $${params.length + 1} ELSE slug END,
             updated_at = now(), last_synced_at = now()
           WHERE id = $${params.length}`,
          [...params, makeSlug(row.titleRomaji ?? row.titleEnglish, row.idMal ?? 0)],
        );
        animeId = animeRow.id;
        outcome = "updated";
      } else {
        const inserted = await client.query<{ id: number }>(
          `INSERT INTO anime (${COLUMNS.join(", ")}, slug, last_synced_at)
           VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}, $${COLUMNS.length + 1}, now()) RETURNING id`,
          [...rowValues(row), makeSlug(row.titleRomaji ?? row.titleEnglish, row.idMal ?? 0)],
        );
        animeId = inserted.rows[0]!.id;
        outcome = "inserted";
      }

      await this.writeGenres(client, animeId, row.genres);
      await this.writeStudios(client, animeId, row);
      return outcome;
    });
  }

  /** Replace the anime's genre links (AniList genres are name-based). */
  private async writeGenres(client: Queryable, animeId: number, genres: MetadataRef[]): Promise<void> {
    const ids: number[] = [];
    for (const g of genres) {
      if (!g.name) continue;
      const id = await resolveGenreId(client, g.name);
      ids.push(id);
      await client.query(
        "INSERT INTO anime_genres (anime_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [animeId, id],
      );
    }
    if (ids.length > 0) {
      await client.query(
        `DELETE FROM anime_genres WHERE anime_id = $1 AND genre_id NOT IN (${ids
          .map((_, i) => `$${i + 2}`)
          .join(", ")})`,
        [animeId, ...ids],
      );
    } else {
      await client.query("DELETE FROM anime_genres WHERE anime_id = $1", [animeId]);
    }
  }

  /** Replace the anime's studio links (matched by AniList id). */
  private async writeStudios(client: Queryable, animeId: number, row: NormalizedAnime): Promise<void> {
    const studios = row.studios.length > 0 ? row.studios : [];
    const ids: number[] = [];
    for (let i = 0; i < studios.length; i += 1) {
      const s = studios[i]!;
      const id = await resolveStudioId(client, {
        id: s.malId,
        name: s.name,
        isAnimationStudio: s.isAnimationStudio ?? i === 0,
      });
      ids.push(id);
      await client.query(
        `INSERT INTO anime_studios (anime_id, studio_id, is_main) VALUES ($1, $2, $3)
         ON CONFLICT (anime_id, studio_id) DO UPDATE SET is_main = EXCLUDED.is_main`,
        [animeId, id, i === 0],
      );
    }
    if (ids.length > 0) {
      await client.query(
        `DELETE FROM anime_studios WHERE anime_id = $1 AND studio_id NOT IN (${ids
          .map((_, i) => `$${i + 2}`)
          .join(", ")})`,
        [animeId, ...ids],
      );
    } else {
      await client.query("DELETE FROM anime_studios WHERE anime_id = $1", [animeId]);
    }
  }
}

export function createAniListUpsertService(db: Database): AniListUpsertService {
  return new AniListUpsertService(db);
}
