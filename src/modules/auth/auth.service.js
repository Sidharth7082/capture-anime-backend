// Auth business logic: registration, login, refresh-token rotation, logout.
// Pure dependency-injected service (repository + jwt + password), so it is
// unit-testable without a database.
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  accessTokenLifetimeMs,
  refreshTokenLifetimeMs,
} from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { ApiError } from '../../lib/errors.js';

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name ?? null,
    avatarUrl: user.avatar_url ?? null,
    role: user.role,
    createdAt: user.created_at,
  };
}

function issueTokens(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: Math.floor(accessTokenLifetimeMs() / 1000),
  };
}

export function createAuthService({ repository, now = () => new Date() } = {}) {
  if (!repository) throw new Error('createAuthService requires a repository');

  async function persistRefreshToken(userId, refreshToken) {
    await repository.createRefreshToken({
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now().getTime() + refreshTokenLifetimeMs()),
    });
  }

  return {
    async register({ username, email, password }) {
      const passwordHash = await hashPassword(password);
      const user = await repository.createUser({ username, email, passwordHash });
      const tokens = issueTokens(user);
      await persistRefreshToken(user.id, tokens.refreshToken);
      return { user: publicUser(user), tokens };
    },

    async login({ identifier, password }) {
      const user = await repository.findByEmailOrUsername(identifier);
      const valid =
        user && (await verifyPassword(password, user.password_hash));
      if (!user || !valid) {
        throw ApiError.unauthorized('Invalid credentials');
      }
      if (user.status !== 'active') {
        throw ApiError.forbidden('Account is disabled');
      }
      const tokens = issueTokens(user);
      await persistRefreshToken(user.id, tokens.refreshToken);
      await repository.touchLastLogin(user.id);
      return { user: publicUser(user), tokens };
    },

    async refresh(refreshToken) {
      if (!refreshToken) throw ApiError.unauthorized('Refresh token required');

      const payload = verifyRefreshToken(refreshToken); // throws 401 on bad signature/expiry
      const stored = await repository.findRefreshTokenByHash(hashToken(refreshToken));

      if (!stored || stored.revoked_at || stored.expires_at <= now()) {
        throw ApiError.unauthorized('Refresh token is invalid or has been revoked');
      }
      if (stored.user_id !== payload.sub) {
        throw ApiError.unauthorized('Refresh token does not match its user');
      }

      const user = await repository.findById(stored.user_id);
      if (!user || user.status !== 'active') {
        throw ApiError.unauthorized('Account is no longer active');
      }

      // Rotation: the used token dies, a fresh pair is issued atomically.
      const tokens = issueTokens(user);
      await repository.rotateRefreshToken({
        oldTokenId: stored.id,
        userId: user.id,
        newTokenHash: hashToken(tokens.refreshToken),
        newExpiresAt: new Date(now().getTime() + refreshTokenLifetimeMs()),
      });

      return { user: publicUser(user), tokens };
    },

    async logout(refreshToken) {
      // Idempotent: revoking an unknown/already-revoked token is a no-op.
      if (refreshToken) {
        await repository.revokeRefreshTokenByHash(hashToken(refreshToken));
      }
      return { success: true };
    },

    async pruneExpiredTokens() {
      return repository.deleteExpiredRefreshTokens();
    },
  };
}
