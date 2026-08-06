// Auth data access. All queries are parameterized; unique-violation errors
// are mapped to friendly ApiError conflicts.
import { ApiError } from '../../lib/errors.js';

function mapCreateUserError(err) {
  // One generic message for all unique violations: distinct messages would
  // let anyone probe which usernames/emails are already registered.
  if (err.code === '23505') {
    throw ApiError.conflict('Username or email is already in use');
  }
  throw err;
}

export function createAuthRepository(pool) {
  return {
    async findByEmailOrUsername(identifier) {
      const { rows } = await pool.query(
        `SELECT id, username, email, password_hash, display_name, avatar_url,
                role, status, created_at, updated_at
           FROM users
          WHERE email = $1 OR username = $1
          LIMIT 1`,
        [identifier],
      );
      return rows[0] ?? null;
    },

    async findById(userId) {
      const { rows } = await pool.query(
        `SELECT id, username, email, password_hash, display_name, avatar_url,
                role, status, created_at, updated_at
           FROM users WHERE id = $1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    async createUser({ username, email, passwordHash }) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (username, email, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, username, email, display_name, avatar_url, role, status, created_at`,
          [username, email, passwordHash],
        );
        return rows[0];
      } catch (err) {
        mapCreateUserError(err);
      }
    },

    async touchLastLogin(userId) {
      await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    },

    // --- refresh tokens ----------------------------------------------------

    async createRefreshToken({ userId, tokenHash, expiresAt }) {
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt],
      );
    },

    async findRefreshTokenByHash(tokenHash) {
      const { rows } = await pool.query(
        `SELECT id, user_id, token_hash, expires_at, revoked_at
           FROM refresh_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      return rows[0] ?? null;
    },

    async revokeRefreshToken(id) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
    },

    async revokeRefreshTokenByHash(tokenHash) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
    },

    /** Atomically revoke the old token and persist the new one (rotation).
     *  Returns false when the old token was already revoked — i.e. the same
     *  refresh token was used concurrently, which the caller treats as replay.
     */
    async rotateRefreshToken({ oldTokenId, userId, newTokenHash, newExpiresAt }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
          [oldTokenId],
        );
        if (rowCount === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
          [userId, newTokenHash, newExpiresAt],
        );
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /** Revoke every live refresh token of a user (replay/family revocation). */
    async revokeAllUserRefreshTokens(userId) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    },

    /** Housekeeping: drop expired tokens (call periodically). */
    async deleteExpiredRefreshTokens() {
      const { rowCount } = await pool.query(
        `DELETE FROM refresh_tokens WHERE expires_at < now()`,
      );
      return rowCount;
    },
  };
}
