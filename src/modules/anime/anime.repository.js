// Anime data access. Every query is parameterized; sort keys are mapped from
// a fixed whitelist so user input never reaches SQL text.
import { ApiError } from '../../lib/errors.js';

export const SORT_SQL = {
  popularity_desc: 'a.popularity DESC NULLS LAST',
  popularity_asc: 'a.popularity ASC NULLS LAST',
  score_desc: 'a.average_score DESC NULLS LAST',
  score_asc: 'a.average_score ASC NULLS LAST',
  recent_desc: 'a.updated_at DESC',
  start_date_desc: 'a.start_date DESC NULLS LAST',
  title_asc: 'a.title_romaji ASC NULLS LAST',
  title_desc: 'a.title_romaji DESC NULLS LAST',
};

const ITEM_COLUMNS = `
  a.id,
  a.anilist_id AS "anilistId",
  a.id_mal AS "idMal",
  a.title_romaji AS "titleRomaji",
  a.title_english AS "titleEnglish",
  a.title_native AS "titleNative",
  a.synonyms,
  a.media_type AS "mediaType",
  a.format,
  a.status,
  a.episodes,
  a.duration_minutes AS "durationMinutes",
  a.season,
  a.season_year AS "seasonYear",
  a.start_date AS "startDate",
  a.end_date AS "endDate",
  a.average_score AS "averageScore",
  a.mean_score AS "meanScore",
  a.popularity,
  a.favourites,
  a.source,
  a.is_adult AS "isAdult",
  a.cover_image_large AS "coverImageLarge",
  a.cover_image_medium AS "coverImageMedium",
  a.cover_image_color AS "coverImageColor",
  a.banner_image AS "bannerImage",
  a.updated_at AS "updatedAt",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name), '[]'::jsonb)
     FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
    WHERE ag.anime_id = a.id) AS genres
`;

// The detail endpoint also returns the (potentially long, HTML) description,
// aliased to "synopsis". Kept separate from ITEM_COLUMNS so list/search
// payloads stay lean.
const DETAIL_COLUMNS = `
  ${ITEM_COLUMNS},
  a.description AS "synopsis"
`;

function buildFilters({ status, format, season, year, includeAdult }) {
  const clauses = [];
  const params = [];
  const add = (clause, value) => {
    if (value !== undefined && value !== null) {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    }
  };
  add('a.status = ?', status);
  add('a.format = ?', format);
  add('a.season = ?', season);
  add('a.season_year = ?', year);
  if (includeAdult !== true) clauses.push('a.is_adult = FALSE');
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function createAnimeRepository(pool) {
  return {
    /** Paginated catalog with filters and a whitelisted sort. */
    async listAnime({ status, format, season, year, includeAdult, sort, limit, offset }) {
      const orderBy = SORT_SQL[sort] ?? SORT_SQL.popularity_desc;
      const { where, params } = buildFilters({ status, format, season, year, includeAdult });

      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${ITEM_COLUMNS}
             FROM anime a
             ${where}
             ORDER BY ${orderBy}
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        pool.query(
          `SELECT count(*)::int AS total FROM anime a ${where}`,
          params,
        ),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async animeExists(id) {
      const { rows } = await pool.query(`SELECT 1 FROM anime WHERE id = $1`, [id]);
      return rows.length > 0;
    },

    async findAnimeById(id) {
      const { rows } = await pool.query(
        `SELECT ${DETAIL_COLUMNS} FROM anime a WHERE a.id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },

    /** Lean lookup used by the streaming (watch) module to resolve a DB anime
     *  id to its AniList id without pulling the whole row. */
    async findAnilistId(id) {
      const { rows } = await pool.query(
        `SELECT a.anilist_id AS "anilistId" FROM anime a WHERE a.id = $1`,
        [id],
      );
      return rows[0]?.anilistId ?? null;
    },

    async findGenresByAnimeId(animeId) {
      const { rows } = await pool.query(
        `SELECT g.id, g.name
           FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
          WHERE ag.anime_id = $1 ORDER BY g.name`,
        [animeId],
      );
      return rows;
    },

    async findStudiosByAnimeId(animeId) {
      const { rows } = await pool.query(
        `SELECT s.id, s.name, s.is_animation_studio AS "isAnimationStudio",
                asl.is_main AS "isMain"
           FROM anime_studios asl JOIN studios s ON s.id = asl.studio_id
          WHERE asl.anime_id = $1
          ORDER BY asl.is_main DESC, s.name`,
        [animeId],
      );
      return rows;
    },

    async findCharactersByAnimeId(animeId, limit = 12) {
      const { rows } = await pool.query(
        `SELECT c.id, c.name_first AS "nameFirst", c.name_last AS "nameLast",
                c.name_native AS "nameNative", c.image_large AS "imageLarge",
                c.image_medium AS "imageMedium", ac.role, ac.sort_order AS "sortOrder",
                (SELECT COALESCE(jsonb_agg(
                    jsonb_build_object('id', s.id, 'nameFirst', s.name_first,
                                       'nameLast', s.name_last, 'language', cs.language)
                    ORDER BY cs.language), '[]'::jsonb)
                   FROM character_staff cs JOIN staff s ON s.id = cs.staff_id
                  WHERE cs.character_id = c.id) AS "voiceActors"
           FROM anime_characters ac
           JOIN characters c ON c.id = ac.character_id
          WHERE ac.anime_id = $1
          ORDER BY CASE ac.role WHEN 'MAIN' THEN 0 WHEN 'SUPPORTING' THEN 1 ELSE 2 END,
                   ac.sort_order
          LIMIT $2`,
        [animeId, limit],
      );
      return rows;
    },

    async findRatingStats(animeId) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS count,
                COALESCE(round(avg(score)::numeric, 2), 0)::float AS average
           FROM ratings WHERE anime_id = $1`,
        [animeId],
      );
      return rows[0];
    },

    async countEpisodes(animeId) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM episodes WHERE anime_id = $1`,
        [animeId],
      );
      return rows[0].count;
    },

    /** Relevance search: full-text + fuzzy title matches. */
    async searchAnime({ q, limit, offset }) {
      const tsQuery = `plainto_tsquery('simple', $1)`;
      const like = `'%' || $2 || '%'`;
      const where = `
        WHERE a.search_vector @@ ${tsQuery}
           OR a.title_romaji  ILIKE ${like}
           OR a.title_english ILIKE ${like}
           OR a.title_native  ILIKE ${like}
      `;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${ITEM_COLUMNS}
             FROM anime a ${where}
             ORDER BY ts_rank(a.search_vector, ${tsQuery}) DESC,
                      a.popularity DESC NULLS LAST
             LIMIT $3 OFFSET $4`,
          [q, `%${q}%`, limit, offset],
        ),
        pool.query(`SELECT count(*)::int AS total FROM anime a ${where}`, [q, `%${q}%`]),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async findGenreById(genreId) {
      const { rows } = await pool.query(
        `SELECT id, name FROM genres WHERE id = $1`,
        [genreId],
      );
      return rows[0] ?? null;
    },

    async listByGenre(genreId, { sort, limit, offset }) {
      const orderBy = SORT_SQL[sort] ?? SORT_SQL.popularity_desc;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${ITEM_COLUMNS}
             FROM anime a
             JOIN anime_genres ag ON ag.anime_id = a.id
            WHERE ag.genre_id = $1 AND a.is_adult = FALSE
            ORDER BY ${orderBy}
            LIMIT $2 OFFSET $3`,
          [genreId, limit, offset],
        ),
        pool.query(
          `SELECT count(*)::int AS total
             FROM anime_genres ag JOIN anime a ON a.id = ag.anime_id
            WHERE ag.genre_id = $1 AND a.is_adult = FALSE`,
          [genreId],
        ),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async findStudioById(studioId) {
      const { rows } = await pool.query(
        `SELECT id, name, is_animation_studio AS "isAnimationStudio" FROM studios WHERE id = $1`,
        [studioId],
      );
      return rows[0] ?? null;
    },

    async listByStudio(studioId, { sort, limit, offset }) {
      const orderBy = SORT_SQL[sort] ?? SORT_SQL.popularity_desc;
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${ITEM_COLUMNS}
             FROM anime a
             JOIN anime_studios ast ON ast.anime_id = a.id
            WHERE ast.studio_id = $1 AND a.is_adult = FALSE
            ORDER BY ${orderBy}
            LIMIT $2 OFFSET $3`,
          [studioId, limit, offset],
        ),
        pool.query(
          `SELECT count(*)::int AS total
             FROM anime_studios ast JOIN anime a ON a.id = ast.anime_id
            WHERE ast.studio_id = $1 AND a.is_adult = FALSE`,
          [studioId],
        ),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async listEpisodesByAnime(animeId, { limit, offset }) {
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, anilist_id AS "anilistId", anime_id AS "animeId", number,
                  title, title_japanese AS "titleJapanese", synopsis,
                  thumbnail_url AS "thumbnailUrl", duration_seconds AS "durationSeconds",
                  air_date AS "airDate", is_filler AS "isFiller", is_recap AS "isRecap",
                  video_url AS "videoUrl"
             FROM episodes
            WHERE anime_id = $1
            ORDER BY number
            LIMIT $2 OFFSET $3`,
          [animeId, limit, offset],
        ),
        pool.query(`SELECT count(*)::int AS total FROM episodes WHERE anime_id = $1`, [animeId]),
      ]);
      return { items: rows, total: countRows[0].total };
    },
  };
}
