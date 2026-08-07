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
      // Backward compatible: deletes by favorite row id OR by anime id
      // (DELETE /api/user/favorites/:animeId). The two paths are run as
      // separate DELETEs so a row id that coincidentally equals another
      // favorite's anime_id can never remove two rows at once.
      const byAnime = await pool.query(
        `DELETE FROM favorites
          WHERE user_id = $1 AND anime_id = $2 AND anime_id IS NOT NULL`,
        [userId, favoriteId],
      );
      if (byAnime.rowCount > 0) return byAnime.rowCount;
      const byId = await pool.query(
        `DELETE FROM favorites WHERE user_id = $1 AND id = $2`,
        [userId, favoriteId],
      );
      return byId.rowCount;
    },

    // --- watch history (write) --------------------------------------------

    async findEpisodeIdByAnimeAndNumber(animeId, number) {
      const { rows } = await pool.query(
        `SELECT id FROM episodes WHERE anime_id = $1 AND number = $2 LIMIT 1`,
        [animeId, number],
      );
      return rows[0]?.id ?? null;
    },

    /** One row per (user, episode): touching an episode again just bumps
     *  watched_at and merges progress — never a duplicate row. */
    async touchHistory(userId, episodeId, { progressSeconds = null, durationSeconds = null, completed = false } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO watch_history (user_id, episode_id, progress_seconds, duration_seconds, completed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, episode_id) DO UPDATE
           SET watched_at = now(),
               progress_seconds = COALESCE(EXCLUDED.progress_seconds, watch_history.progress_seconds),
               duration_seconds = COALESCE(EXCLUDED.duration_seconds, watch_history.duration_seconds),
               completed = watch_history.completed OR EXCLUDED.completed
         RETURNING id, watched_at AS "watchedAt"`,
        [userId, episodeId, progressSeconds, durationSeconds, completed],
      );
      return rows[0];
    },

    // --- continue watching -------------------------------------------------

    async listContinueWatching(userId, { limit, offset }) {
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT cw.id, cw.anime_id AS "animeId",
                  cw.episode_number AS "episodeNumber",
                  cw.playback_position_seconds AS "playbackPositionSeconds",
                  cw.duration_seconds AS "durationSeconds",
                  cw.updated_at AS "updatedAt",
                  jsonb_strip_nulls(jsonb_build_object(
                    'id', a.id,
                    'title', coalesce(a.title_romaji, a.title_english, a.title_native),
                    'coverImageLarge', a.cover_image_large,
                    'coverImageMedium', a.cover_image_medium,
                    'format', a.format,
                    'episodes', a.episodes
                  )) AS anime
             FROM continue_watching cw
             JOIN anime a ON a.id = cw.anime_id
            WHERE cw.user_id = $1
            ORDER BY cw.updated_at DESC
            LIMIT $2 OFFSET $3`,
          [userId, limit, offset],
        ),
        pool.query(`SELECT count(*)::int AS total FROM continue_watching WHERE user_id = $1`, [userId]),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async upsertContinueWatching(userId, { animeId, episodeNumber, playbackPositionSeconds, durationSeconds }) {
      const { rows } = await pool.query(
        `INSERT INTO continue_watching
           (user_id, anime_id, episode_number, playback_position_seconds, duration_seconds, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, anime_id) DO UPDATE
           SET episode_number = EXCLUDED.episode_number,
               playback_position_seconds = EXCLUDED.playback_position_seconds,
               duration_seconds = COALESCE(EXCLUDED.duration_seconds, continue_watching.duration_seconds),
               updated_at = now()
         RETURNING id, anime_id AS "animeId", episode_number AS "episodeNumber",
                   playback_position_seconds AS "playbackPositionSeconds",
                   duration_seconds AS "durationSeconds", updated_at AS "updatedAt"`,
        [userId, animeId, episodeNumber, playbackPositionSeconds, durationSeconds ?? null],
      );
      return rows[0];
    },

    async deleteContinueWatching(userId, animeId) {
      const { rowCount } = await pool.query(
        `DELETE FROM continue_watching WHERE user_id = $1 AND anime_id = $2`,
        [userId, animeId],
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
