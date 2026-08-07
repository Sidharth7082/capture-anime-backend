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
import { hashPassword, verifyPassword, dummyHash } from '../../lib/password.js';
import { ApiError } from '../../lib/errors.js';

// (Bcrypt hash cost for the timing equalizer now comes from password.js, so
// it can never drift from the real BCRYPT_ROUNDS — see dummyHash().)

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
      // Atomic: the user row and its FIRST refresh token are created in one
      // transaction — a failure can't leave an account without a session.
      const { user, refreshToken } = await repository.createUserWithRefreshToken({
        username,
        email,
        passwordHash,
        makeRefreshToken: (userId) => {
          const token = signRefreshToken({ id: userId });
          return {
            refreshToken: token,
            tokenHash: hashToken(token),
            expiresAt: new Date(now().getTime() + refreshTokenLifetimeMs()),
          };
        },
      });
      // issueTokens() signs a fresh refresh token; override it with the one
      // actually persisted so the client's token survives a refresh.
      const tokens = { ...issueTokens(user), refreshToken };
      return { user: publicUser(user), tokens };
    },

    async login({ identifier, password }) {
      const user = await repository.findByEmailOrUsername(identifier);
      // Always run bcrypt — against the dummy hash when the account is
      // unknown — so response timing does not reveal valid usernames.
      const passwordOk = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
      if (!user || !passwordOk) {
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

      if (!stored || stored.expires_at <= now()) {
        throw ApiError.unauthorized('Refresh token is invalid or has been revoked');
      }

      // A revoked token presented again means the token (or its rotation) was
      // stolen — kill the whole token family and force a fresh login.
      if (stored.revoked_at) {
        await repository.revokeAllUserRefreshTokens(stored.user_id);
        throw ApiError.unauthorized('Refresh token has been revoked');
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
      const rotated = await repository.rotateRefreshToken({
        oldTokenId: stored.id,
        userId: user.id,
        newTokenHash: hashToken(tokens.refreshToken),
        newExpiresAt: new Date(now().getTime() + refreshTokenLifetimeMs()),
      });

      // Concurrent double-submit: the old token was revoked between our read
      // and the update — treat as replay.
      if (rotated === false) {
        await repository.revokeAllUserRefreshTokens(user.id);
        throw ApiError.unauthorized('Refresh token has been revoked');
      }

      return { user: publicUser(user), tokens };
    },

    async logout(refreshTokens) {
      // Idempotent: revoking an unknown/already-revoked token is a no-op.
      const list = Array.isArray(refreshTokens) ? refreshTokens : [refreshTokens];
      for (const refreshToken of list) {
        if (refreshToken) {
          await repository.revokeRefreshTokenByHash(hashToken(refreshToken));
        }
      }
      return { success: true };
    },

    async pruneExpiredTokens() {
      return repository.deleteExpiredRefreshTokens();
    },
  };
}
