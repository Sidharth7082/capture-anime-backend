/**
 * Stage 4 write layer. Implements UpsertPort<NormalizedAnimeEnrichment>:
 * enriches ONE existing anime inside a single transaction — characters and
 * voice actors (staff) are resolved by mal_id (falling back to name to link
 * AniList-imported rows), join rows are written with stale-pruning, and
 * relations / recommendations / pictures / videos are replace-per-anime so
 * the DB mirrors Jikan exactly.
 *
 * Only anime already present in the `anime` table are touched (enrichment
 * never creates rows).
 */
import type { Database } from "../database.js";
import type {
  EnrichCharacter,
  EnrichStaffMember,
  NormalizedAnimeEnrichment,
  UpsertPort,
} from "./types.js";

interface Queryable {
  query<T = { id: number }>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

async function resolveCharacterId(
  client: Queryable,
  c: EnrichCharacter,
): Promise<number> {
  const { first, last } = splitName(c.name);
  const byMal = await client.query<{ id: number }>(
    "SELECT id FROM characters WHERE mal_id = $1 LIMIT 1",
    [c.malId],
  );
  if (byMal.rows[0]) {
    const id = byMal.rows[0].id;
    await client.query(
      `UPDATE characters SET name_first = $2, name_last = $3, name_native = $4,
       image_large = $5, image_medium = $5, updated_at = now() WHERE id = $1`,
      [id, first, last, c.nameKanji, c.imageUrl],
    );
    return id;
  }
  const byName = await client.query<{ id: number }>(
    "SELECT id FROM characters WHERE name_first = $1 LIMIT 1",
    [first],
  );
  if (byName.rows[0]) {
    const id = byName.rows[0].id;
    await client.query(
      `UPDATE characters SET mal_id = $2, name_last = $3, name_native = $4,
       image_large = $5, image_medium = $5, updated_at = now() WHERE id = $1`,
      [id, c.malId, last, c.nameKanji, c.imageUrl],
    );
    return id;
  }
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO characters (mal_id, name_first, name_last, name_native, image_large, image_medium, favourites)
     VALUES ($1, $2, $3, $4, $5, $5, 0) RETURNING id`,
    [c.malId, first, last, c.nameKanji, c.imageUrl],
  );
  return inserted.rows[0]!.id;
}

async function resolveStaffId(
  client: Queryable,
  s: EnrichStaffMember,
  language: string | null,
): Promise<number> {
  const { first, last } = splitName(s.name);
  const byMal = await client.query<{ id: number }>(
    "SELECT id FROM staff WHERE mal_id = $1 LIMIT 1",
    [s.malId],
  );
  if (byMal.rows[0]) {
    const id = byMal.rows[0].id;
    await client.query(
      `UPDATE staff SET name_first = $2, name_last = $3, image_large = $4,
       language = COALESCE($5, language), updated_at = now() WHERE id = $1`,
      [id, first, last, s.imageUrl, language],
    );
    return id;
  }
  const byName = await client.query<{ id: number }>(
    "SELECT id FROM staff WHERE name_first = $1 LIMIT 1",
    [first],
  );
  if (byName.rows[0]) {
    const id = byName.rows[0].id;
    await client.query(
      `UPDATE staff SET mal_id = $2, name_last = $3, image_large = $4,
       language = COALESCE($5, language), updated_at = now() WHERE id = $1`,
      [id, s.malId, last, s.imageUrl, language],
    );
    return id;
  }
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO staff (mal_id, name_first, name_last, language, image_large)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [s.malId, first, last, language ?? "Japanese", s.imageUrl],
  );
  return inserted.rows[0]!.id;
}

export class AnimeEnrichUpsertService implements UpsertPort<NormalizedAnimeEnrichment> {
  constructor(private readonly db: Database) {}

  /** Enrich one anime's content relationships (atomic). Always "updated". */
  async upsert(row: NormalizedAnimeEnrichment): Promise<"inserted" | "updated"> {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{ id: number }>(
        "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
        [row.idMal],
      );
      const animeRow = existing.rows[0];
      if (!animeRow) return "updated" as const; // not in the catalog yet
      const animeId = animeRow.id;

      await this.writeCharactersAndVoiceActors(client, animeId, row);
      await this.writeStaff(client, animeId, row);
      await this.replaceRelations(client, animeId, row);
      await this.replaceRecommendations(client, animeId, row);
      await this.replacePictures(client, animeId, row);
      await this.replaceVideos(client, animeId, row);
      return "updated" as const;
    });
  }

  private async writeCharactersAndVoiceActors(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    const before = await client.query<{ character_id: number }>(
      "SELECT character_id FROM anime_characters WHERE anime_id = $1",
      [animeId],
    );

    const newIds: number[] = [];
    const voiceLinks: Array<{ characterId: number; staffId: number; language: string | null }> = [];
    for (const c of row.characters) {
      const characterId = await resolveCharacterId(client, c);
      newIds.push(characterId);
      await client.query(
        `INSERT INTO anime_characters (anime_id, character_id, role, sort_order, favourites)
         VALUES ($1, $2, $3, $4, 0) ON CONFLICT (anime_id, character_id)
         DO UPDATE SET role = EXCLUDED.role, sort_order = EXCLUDED.sort_order`,
        [animeId, characterId, c.role, c.sortOrder],
      );
      for (const va of c.voiceActors) {
        const staffId = await resolveStaffId(client, { malId: va.malId, name: va.name, imageUrl: va.imageUrl, positions: [] }, va.language);
        voiceLinks.push({ characterId, staffId, language: va.language });
      }
    }

    // Prune voice links + character joins for characters Jikan no longer lists.
    if (before.rows.length > 0) {
      await client.query(
        `DELETE FROM character_staff
         WHERE character_id IN (SELECT character_id FROM anime_characters WHERE anime_id = $1)
           AND character_id NOT IN (${newIds.length ? newIds.map((_, i) => `$${i + 2}`).join(", ") : "NULL"})`,
        [animeId, ...newIds],
      );
    }
    if (newIds.length > 0) {
      await client.query(
        `DELETE FROM anime_characters WHERE anime_id = $1 AND character_id NOT IN (${newIds
          .map((_, i) => `$${i + 2}`)
          .join(", ")})`,
        [animeId, ...newIds],
      );
    } else {
      await client.query("DELETE FROM anime_characters WHERE anime_id = $1", [animeId]);
      await client.query(
        "DELETE FROM character_staff WHERE character_id IN (SELECT character_id FROM anime_characters WHERE anime_id = $1)",
        [animeId],
      );
    }

    for (const link of voiceLinks) {
      await client.query(
        `INSERT INTO character_staff (character_id, staff_id, language) VALUES ($1, $2, $3)
         ON CONFLICT (character_id, staff_id, language) DO NOTHING`,
        [link.characterId, link.staffId, link.language ?? "Japanese"],
      );
    }
  }

  private async writeStaff(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    const newIds: number[] = [];
    for (const s of row.staff) {
      const staffId = await resolveStaffId(client, s, null);
      newIds.push(staffId);
      await client.query(
        `INSERT INTO anime_staff (anime_id, staff_id, positions) VALUES ($1, $2, $3)
         ON CONFLICT (anime_id, staff_id) DO UPDATE SET positions = EXCLUDED.positions`,
        [animeId, staffId, s.positions],
      );
    }
    if (newIds.length > 0) {
      await client.query(
        `DELETE FROM anime_staff WHERE anime_id = $1 AND staff_id NOT IN (${newIds
          .map((_, i) => `$${i + 2}`)
          .join(", ")})`,
        [animeId, ...newIds],
      );
    } else {
      await client.query("DELETE FROM anime_staff WHERE anime_id = $1", [animeId]);
    }
  }

  private async replaceRelations(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    await client.query("DELETE FROM anime_relations WHERE anime_id = $1", [animeId]);
    for (const [index, r] of row.relations.entries()) {
      let relatedId: number | null = null;
      if (r.mediaType === "anime") {
        const hit = await client.query<{ id: number }>(
          "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
          [r.malId],
        );
        relatedId = hit.rows[0]?.id ?? null;
      }
      await client.query(
        `INSERT INTO anime_relations (anime_id, related_anime_id, mal_id, media_type, name, relation, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [animeId, relatedId, r.malId, r.mediaType, r.name, r.relation, index],
      );
    }
  }

  private async replaceRecommendations(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    await client.query("DELETE FROM anime_recommendations WHERE anime_id = $1", [animeId]);
    for (const [index, rec] of row.recommendations.entries()) {
      const hit = await client.query<{ id: number }>(
        "SELECT id FROM anime WHERE id_mal = $1 ORDER BY id LIMIT 1",
        [rec.malId],
      );
      await client.query(
        `INSERT INTO anime_recommendations (anime_id, recommended_anime_id, mal_id, title, votes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [animeId, hit.rows[0]?.id ?? null, rec.malId, rec.title, rec.votes, index],
      );
    }
  }

  private async replacePictures(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    await client.query("DELETE FROM anime_pictures WHERE anime_id = $1", [animeId]);
    for (const [index, p] of row.pictures.entries()) {
      await client.query(
        `INSERT INTO anime_pictures (anime_id, image_url, large_image_url, webp_url, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [animeId, p.imageUrl, p.largeImageUrl, p.webpUrl, index],
      );
    }
  }

  private async replaceVideos(
    client: Queryable,
    animeId: number,
    row: NormalizedAnimeEnrichment,
  ): Promise<void> {
    await client.query("DELETE FROM anime_videos WHERE anime_id = $1", [animeId]);
    for (const [index, v] of row.videos.entries()) {
      await client.query(
        `INSERT INTO anime_videos (anime_id, kind, youtube_id, title, url, embed_url, thumbnail_large, episode_number, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [animeId, v.kind, v.youtubeId, v.title, v.url, v.embedUrl, v.thumbnailLarge, v.episodeNumber, index],
      );
    }
  }
}

export function createAnimeEnrichUpsertService(db: Database): AnimeEnrichUpsertService {
  return new AnimeEnrichUpsertService(db);
}
