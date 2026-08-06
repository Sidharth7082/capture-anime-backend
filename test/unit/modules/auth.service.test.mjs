import '../helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../../../src/modules/auth/auth.service.js';
import { hashPassword } from '../../../src/lib/password.js';
import { hashToken } from '../../../src/lib/jwt.js';
import { ApiError } from '../../../src/lib/errors.js';

/** In-memory fake of auth.repository with refresh-token storage. */
function makeFakeRepository() {
  const users = [];
  const tokens = new Map();
  let nextUserId = 1;
  let nextTokenId = 1;

  const repo = {
    users,
    tokens,
    calls: { createUser: 0, rotate: 0, revokeByHash: 0, lastLogin: 0 },

    async findByEmailOrUsername(identifier) {
      return users.find((u) => u.email === identifier || u.username === identifier) ?? null;
    },
    async findById(id) {
      return users.find((u) => u.id === id) ?? null;
    },
    async createUser({ username, email, passwordHash }) {
      repo.calls.createUser += 1;
      const user = {
        id: `u${nextUserId++}`,
        username,
        email,
        password_hash: passwordHash,
        display_name: null,
        avatar_url: null,
        role: 'viewer',
        status: 'active',
        created_at: new Date().toISOString(),
      };
      users.push(user);
      return user;
    },
    async touchLastLogin() {
      repo.calls.lastLogin += 1;
    },
    async createRefreshToken({ userId, tokenHash, expiresAt }) {
      tokens.set(tokenHash, { id: nextTokenId++, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, revoked_at: null });
    },
    async findRefreshTokenByHash(tokenHash) {
      return tokens.get(tokenHash) ?? null;
    },
    async revokeRefreshToken(id) {
      for (const t of tokens.values()) if (t.id === id) t.revoked_at = new Date();
    },
    async revokeRefreshTokenByHash(tokenHash) {
      repo.calls.revokeByHash += 1;
      const t = tokens.get(tokenHash);
      if (t) t.revoked_at = new Date();
    },
    async rotateRefreshToken({ oldTokenId, userId, newTokenHash, newExpiresAt }) {
      repo.calls.rotate += 1;
      for (const t of tokens.values()) if (t.id === oldTokenId) t.revoked_at = new Date();
      tokens.set(newTokenHash, { id: nextTokenId++, user_id: userId, token_hash: newTokenHash, expires_at: newExpiresAt, revoked_at: null });
    },
    async deleteExpiredRefreshTokens() {
      let n = 0;
      for (const [k, t] of tokens) if (t.expires_at < new Date()) { tokens.delete(k); n += 1; }
      return n;
    },
  };
  return repo;
}

let repo;
let service;
beforeEach(() => {
  repo = makeFakeRepository();
  service = createAuthService({ repository: repo });
});

test('register hashes the password and returns user + tokens', async () => {
  const { user, tokens } = await service.register({
    username: 'alice',
    email: 'alice@example.com',
    password: 'supersecret1',
  });

  assert.equal(user.username, 'alice');
  assert.equal(user.passwordHash, undefined); // never exposed
  assert.ok(user.email === 'alice@example.com');
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.equal(tokens.tokenType, 'Bearer');

  const storedUser = repo.users[0];
  assert.notEqual(storedUser.password_hash, 'supersecret1'); // hashed
  assert.equal(repo.calls.createUser, 1);

  // refresh token persisted as a hash, not raw
  const rawHash = hashToken(tokens.refreshToken);
  assert.ok(repo.tokens.has(rawHash));
  assert.equal([...repo.tokens.values()][0].user_id, user.id);
});

test('login rejects wrong password with 401', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('correct-password'),
    display_name: null,
    avatar_url: null,
    role: 'viewer',
    status: 'active',
    created_at: new Date().toISOString(),
  });

  await assert.rejects(
    service.login({ identifier: 'alice@example.com', password: 'wrong-password' }),
    (err) => err instanceof ApiError && err.status === 401,
  );
  await assert.rejects(
    service.login({ identifier: 'ghost', password: 'correct-password' }),
    (err) => err instanceof ApiError && err.status === 401,
  );
});

test('login succeeds with valid credentials and touches last login', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('correct-password'),
    display_name: null,
    avatar_url: null,
    role: 'viewer',
    status: 'active',
    created_at: new Date().toISOString(),
  });

  const { user, tokens } = await service.login({ identifier: 'alice', password: 'correct-password' });
  assert.equal(user.id, 'u1');
  assert.ok(tokens.refreshToken);
  assert.equal(repo.calls.lastLogin, 1);
});

test('login rejects disabled accounts with 403', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('correct-password'),
    status: 'suspended',
  });
  await assert.rejects(
    service.login({ identifier: 'alice', password: 'correct-password' }),
    (err) => err instanceof ApiError && err.status === 403,
  );
});

test('refresh rotates the token pair', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('p'),
    status: 'active',
  });
  const first = await service.login({ identifier: 'alice', password: 'p' });

  const result = await service.refresh(first.tokens.refreshToken);
  assert.notEqual(result.tokens.refreshToken, first.tokens.refreshToken);
  assert.notEqual(result.tokens.accessToken, first.tokens.accessToken);

  // old token is revoked, new one is stored
  const oldRow = repo.tokens.get(hashToken(first.tokens.refreshToken));
  assert.ok(oldRow.revoked_at);
  assert.ok(repo.tokens.has(hashToken(result.tokens.refreshToken)));
  assert.equal(repo.calls.rotate, 1);
});

test('refresh rejects a revoked token', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('p'),
    status: 'active',
  });
  const { tokens } = await service.login({ identifier: 'alice', password: 'p' });
  await service.logout(tokens.refreshToken);

  await assert.rejects(service.refresh(tokens.refreshToken), (err) => err.status === 401);
});

test('refresh rejects a missing token', async () => {
  await assert.rejects(service.refresh(undefined), (err) => err.status === 401);
  await assert.rejects(service.refresh(''), (err) => err.status === 401);
});

test('refresh rejects an expired token', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../../../src/config/env.js');
  const expired = jwt.sign(
    { type: 'refresh', sub: 'u1', jti: 'x' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: -10 },
  );
  await assert.rejects(service.refresh(expired), (err) => err.status === 401);
});

test('logout revokes the refresh token (idempotent)', async () => {
  repo.users.push({
    id: 'u1',
    username: 'alice',
    email: 'alice@example.com',
    password_hash: await hashPassword('p'),
    status: 'active',
  });
  const { tokens } = await service.login({ identifier: 'alice', password: 'p' });

  const res = await service.logout(tokens.refreshToken);
  assert.deepEqual(res, { success: true });
  assert.equal(repo.tokens.get(hashToken(tokens.refreshToken)).revoked_at !== null, true);

  // second logout is a harmless no-op
  await service.logout(tokens.refreshToken);
  assert.equal(repo.calls.revokeByHash, 2);
});

test('pruneExpiredTokens removes expired rows', async () => {
  repo.tokens.set('expired-hash', { id: 1, user_id: 'u1', token_hash: 'expired-hash', expires_at: new Date(Date.now() - 1000), revoked_at: null });
  repo.tokens.set('live-hash', { id: 2, user_id: 'u1', token_hash: 'live-hash', expires_at: new Date(Date.now() + 100_000), revoked_at: null });
  const pruned = await service.pruneExpiredTokens();
  assert.equal(pruned, 1);
  assert.ok(repo.tokens.has('live-hash'));
});
