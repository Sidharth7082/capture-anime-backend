// User data access (profile, favorites, watch history).
import { ApiError } from '../../lib/errors.js';

const FAVORITE_ITEM = `
  jsonb_strip_nulls(jsonb_build_object(
    'id', a.id,
    'title', coalesce(a.title_romaji, a.title_english, a.title_native),
    'coverImageLarge', a.cover_image_large,
    'format', a.format,
    'episodes', a.episodes
  )) AS anime,
  jsonb_strip_nulls(jsonb_build_object(
    'id', c.id,
    'nameFirst', c.name_first,
    'nameLast', c.name_last,
    'imageLarge', c.image_large
  )) AS character,
  jsonb_strip_nulls(jsonb_build_object(
    'id', s.id,
    'nameFirst', s.name_first,
    'nameLast', s.name_last,
    'language', s.language,
    'imageLarge', s.image_large
  )) AS staff
`;

function favoriteType({ animeId, characterId, staffId }) {
  if (animeId !== undefined && animeId !== null) return 'anime';
  if (characterId !== undefined && characterId !== null) return 'character';
  return 'staff';
}

export function createUserRepository(pool) {
  return {
    async findPublicById(userId) {
      const { rows } = await pool.query(
        `SELECT id, username, email, display_name AS "displayName",
                avatar_url AS "avatarUrl", role, created_at AS "createdAt"
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    // --- favorites ---------------------------------------------------------

    async listFavorites(userId, { limit, offset }) {
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT f.id, f.created_at AS "createdAt",
                  CASE
                    WHEN f.anime_id IS NOT NULL THEN 'anime'
                    WHEN f.character_id IS NOT NULL THEN 'character'
                    ELSE 'staff'
                  END AS type,
                  f.anime_id AS "animeId",
                  f.character_id AS "characterId",
                  f.staff_id AS "staffId",
                  ${FAVORITE_ITEM}
             FROM favorites f
             LEFT JOIN anime a      ON a.id = f.anime_id
             LEFT JOIN characters c ON c.id = f.character_id
             LEFT JOIN staff s      ON s.id = f.staff_id
            WHERE f.user_id = $1
            ORDER BY f.created_at DESC, f.id DESC
            LIMIT $2 OFFSET $3`,
          [userId, limit, offset],
        ),
        pool.query(`SELECT count(*)::int AS total FROM favorites WHERE user_id = $1`, [userId]),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async findFavoriteByTarget(userId, { animeId, characterId, staffId }) {
      const { rows } = await pool.query(
        `SELECT id, created_at AS "createdAt"
           FROM favorites
          WHERE user_id = $1
            AND (($2::bigint IS NOT NULL AND anime_id = $2)
              OR ($3::bigint IS NOT NULL AND character_id = $3)
              OR ($4::bigint IS NOT NULL AND staff_id = $4))
          LIMIT 1`,
        [userId, animeId ?? null, characterId ?? null, staffId ?? null],
      );
      if (!rows[0]) return null;
      return { ...rows[0], type: favoriteType({ animeId, characterId, staffId }) };
    },

    async addFavorite(userId, { animeId, characterId, staffId }) {
      const type = favoriteType({ animeId, characterId, staffId });
      try {
        const { rows } = await pool.query(
          `INSERT INTO favorites (user_id, anime_id, character_id, staff_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING id, created_at AS "createdAt"`,
          [userId, animeId ?? null, characterId ?? null, staffId ?? null],
        );
        if (rows[0]) return { ...rows[0], type, created: true };
        // Already favorited — return the existing row as a no-op success.
        const existing = await this.findFavoriteByTarget(userId, { animeId, characterId, staffId });
        return { ...existing, type, created: false };
      } catch (err) {
        if (err.code === '23503') {
          throw ApiError.badRequest('The target does not exist');
        }
        throw err;
      }
    },

    async deleteFavorite(userId, favoriteId) {
      const { rowCount } = await pool.query(
        `DELETE FROM favorites WHERE id = $1 AND user_id = $2`,
        [favoriteId, userId],
      );
      return rowCount;
    },

    // --- watch history -----------------------------------------------------

    async listHistory(userId, { animeId, limit, offset }) {
      const params = [userId];
      const animeClause = animeId ? `AND e.anime_id = $${params.length + 1}` : '';
      if (animeId) params.push(animeId);

      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT wh.id, wh.watched_at AS "watchedAt",
                  wh.progress_seconds AS "progressSeconds",
                  wh.duration_seconds AS "durationSeconds",
                  wh.completed,
                  e.id AS "episodeId", e.number, e.title AS "episodeTitle",
                  e.thumbnail_url AS "episodeThumbnail",
                  a.id AS "animeId",
                  coalesce(a.title_romaji, a.title_english, a.title_native) AS "animeTitle",
                  a.cover_image_large AS "animeCoverImage"
             FROM watch_history wh
             JOIN episodes e ON e.id = wh.episode_id
             JOIN anime a    ON a.id = e.anime_id
            WHERE wh.user_id = $1 ${animeClause}
            ORDER BY wh.watched_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        pool.query(
          `SELECT count(*)::int AS total
             FROM watch_history wh
             JOIN episodes e ON e.id = wh.episode_id
            WHERE wh.user_id = $1 ${animeClause}`,
          params,
        ),
      ]);
      return { items: rows, total: countRows[0].total };
    },
  };
}
