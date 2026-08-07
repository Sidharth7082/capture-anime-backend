// MAL sync data access. Token rows are ciphertext — the plaintext tokens
// only exist inside the service, briefly, while talking to MAL.

const ENTRY_COLUMNS = `
  e.id, e.user_id AS "userId", e.mal_anime_id AS "malAnimeId",
  e.anime_id AS "animeId", e.status, e.score,
  e.episodes_watched AS "episodesWatched", e.rewatch_count AS "rewatchCount",
  e.is_rewatching AS "isRewatching", e.updated_at AS "updatedAt",
  jsonb_strip_nulls(jsonb_build_object(
    'id', a.id,
    'malId', a.id_mal,
    'title', coalesce(a.title_romaji, a.title_english, a.title_native),
    'coverImageLarge', a.cover_image_large,
    'coverImageMedium', a.cover_image_medium,
    'format', a.format,
    'episodes', a.episodes
  )) AS anime`;

export function createMalRepository(pool) {
  return {
    // --- account -----------------------------------------------------------

    async upsertAccount({ userId, malId, malUsername, accessTokenEnc, refreshTokenEnc, tokenExpiresAt, scopes }) {
      const { rows } = await pool.query(
        `INSERT INTO mal_accounts
           (user_id, mal_id, mal_username, access_token_enc, refresh_token_enc, token_expires_at, scopes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE
           SET mal_id = EXCLUDED.mal_id,
               mal_username = EXCLUDED.mal_username,
               access_token_enc = EXCLUDED.access_token_enc,
               refresh_token_enc = EXCLUDED.refresh_token_enc,
               token_expires_at = EXCLUDED.token_expires_at,
               scopes = EXCLUDED.scopes,
               updated_at = now()
         RETURNING user_id AS "userId", mal_username AS "malUsername"`,
        [userId, malId, malUsername, accessTokenEnc, refreshTokenEnc, tokenExpiresAt, scopes],
      );
      return rows[0];
    },

    async findAccountByUser(userId) {
      const { rows } = await pool.query(
        `SELECT user_id AS "userId", mal_id AS "malId", mal_username AS "malUsername",
                access_token_enc AS "accessTokenEnc", refresh_token_enc AS "refreshTokenEnc",
                token_expires_at AS "tokenExpiresAt", scopes
           FROM mal_accounts WHERE user_id = $1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    /** Remove the account AND all synced entries (single transaction). */
    async deleteAccount(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM mal_anime_entries WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM mal_accounts WHERE user_id = $1', [userId]);
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // --- pending PKCE state (server-side, no cookies) ------------------------

    async insertPending({ state, codeVerifier, userId, expiresAt }) {
      await pool.query(
        `INSERT INTO pending_mal_oauth (state, code_verifier, user_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [state, codeVerifier, userId, expiresAt],
      );
    },

    /**
     * Atomically consume a pending OAuth record. Returns the verifier + user
     * when the state exists and hasn't expired; null otherwise.
     */
    async consumePending(state) {
      const { rows } = await pool.query(
        `DELETE FROM pending_mal_oauth
          WHERE state = $1 AND expires_at > now()
          RETURNING code_verifier AS "codeVerifier", user_id AS "userId"`,
        [state],
      );
      return rows[0] ?? null;
    },

    // --- matching ----------------------------------------------------------

    /** Local anime id for a MAL id, or null (id_mal column from AniList import). */
    async findAnimeIdByMalId(malId) {
      const { rows } = await pool.query(
        `SELECT id FROM anime WHERE id_mal = $1 LIMIT 1`,
        [malId],
      );
      return rows[0]?.id ?? null;
    },

    // --- entries -----------------------------------------------------------

    async upsertEntry(userId, { malAnimeId, animeId, status, score, episodesWatched, isRewatching, rewatchCount, updatedAt }) {
      const { rows } = await pool.query(
        `INSERT INTO mal_anime_entries
           (user_id, mal_anime_id, anime_id, status, score, episodes_watched, rewatch_count, is_rewatching, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, mal_anime_id) DO UPDATE
           SET anime_id = COALESCE(EXCLUDED.anime_id, mal_anime_entries.anime_id),
               status = EXCLUDED.status,
               score = EXCLUDED.score,
               episodes_watched = EXCLUDED.episodes_watched,
               rewatch_count = EXCLUDED.rewatch_count,
               is_rewatching = EXCLUDED.is_rewatching,
               updated_at = EXCLUDED.updated_at
         RETURNING id, mal_anime_id AS "malAnimeId", anime_id AS "animeId"`,
        [userId, malAnimeId, animeId, status, score, episodesWatched, rewatchCount, isRewatching, updatedAt],
      );
      return rows[0];
    },

    async listEntries(userId, { status = null, limit, offset }) {
      const where = ['e.user_id = $1'];
      const params = [userId];
      if (status) {
        params.push(status);
        where.push(`e.status = $${params.length}`);
      }
      params.push(limit, offset);
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT ${ENTRY_COLUMNS}
             FROM mal_anime_entries e
             LEFT JOIN anime a ON a.id = e.anime_id
            WHERE ${where.join(' AND ')}
            ORDER BY e.updated_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
        pool.query(`SELECT count(*)::int AS total FROM mal_anime_entries e WHERE ${where.join(' AND ')}`, params.slice(0, -2)),
      ]);
      return { items: rows, total: countRows[0].total };
    },

    async findEntry(userId, malAnimeId) {
      const { rows } = await pool.query(
        `SELECT ${ENTRY_COLUMNS}
           FROM mal_anime_entries e
           LEFT JOIN anime a ON a.id = e.anime_id
          WHERE e.user_id = $1 AND e.mal_anime_id = $2`,
        [userId, malAnimeId],
      );
      return rows[0] ?? null;
    },

    /** Entry for a LOCAL anime id (used by the player's auto-progress push). */
    async findEntryByAnimeId(userId, animeId) {
      const { rows } = await pool.query(
        `SELECT ${ENTRY_COLUMNS}
           FROM mal_anime_entries e
           LEFT JOIN anime a ON a.id = e.anime_id
          WHERE e.user_id = $1 AND e.anime_id = $2
          LIMIT 1`,
        [userId, animeId],
      );
      return rows[0] ?? null;
    },

    async deleteEntry(userId, malAnimeId) {
      const { rowCount } = await pool.query(
        `DELETE FROM mal_anime_entries WHERE user_id = $1 AND mal_anime_id = $2`,
        [userId, malAnimeId],
      );
      return rowCount;
    },

    /** Remove local rows that are no longer on the MAL list (full sync). */
    async deleteEntriesExcept(userId, malAnimeIds) {
      if (malAnimeIds.length === 0) {
        const { rowCount } = await pool.query(`DELETE FROM mal_anime_entries WHERE user_id = $1`, [userId]);
        return rowCount;
      }
      const { rowCount } = await pool.query(
        `DELETE FROM mal_anime_entries
          WHERE user_id = $1 AND mal_anime_id != ALL($2::bigint[])`,
        [userId, malAnimeIds],
      );
      return rowCount;
    },
  };
}
