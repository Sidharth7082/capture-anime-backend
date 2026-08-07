// auth.repository tests against the real schema (PGlite): user creation,
// credential lookup, refresh-token lifecycle (create / verify / rotate /
// revoke / cleanup) and duplicate handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../../helpers/pglite.mjs';
import { createAuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { hashPassword } from '../../../src/lib/password.js';

async function setup() {
  const { pool } = await createTestDb();
  const repo = createAuthRepository(pool);
  const passwordHash = await hashPassword('hunter2');
  return { pool, repo, passwordHash };
}

test('createUser enforces unique username/email and returns a uuid', async () => {
  const { repo, passwordHash } = await setup();
  const user = await repo.createUser({ username: 'alice', email: 'alice@example.com', passwordHash });
  assert.equal(typeof user.id, 'string');
  assert.equal(user.username, 'alice');

  // Duplicate username is rejected; duplicate email is rejected.
  await assert.rejects(repo.createUser({ username: 'alice', email: 'other@example.com', passwordHash }));
  await assert.rejects(repo.createUser({ username: 'bob', email: 'alice@example.com', passwordHash }));
  // Different username + email still works.
  await repo.createUser({ username: 'bob', email: 'bob@example.com', passwordHash });
});

test('findByEmailOrUsername matches both identifiers; findById resolves', async () => {
  const { repo, passwordHash } = await setup();
  const user = await repo.createUser({ username: 'alice', email: 'alice@example.com', passwordHash });

  const byEmail = await repo.findByEmailOrUsername('alice@example.com');
  assert.equal(byEmail.id, user.id);
  const byUsername = await repo.findByEmailOrUsername('alice');
  assert.equal(byUsername.id, user.id);
  assert.equal(byUsername.password_hash.length > 0, true);

  assert.equal(await repo.findByEmailOrUsername('nobody'), null);
  assert.equal((await repo.findById(user.id)).username, 'alice');
  assert.equal(await repo.findById('00000000-0000-4000-8000-000000000000'), null);
});

test('refresh tokens: create, verify, rotate, revoke, expire cleanup', async () => {
  const { pool, repo, passwordHash } = await setup();
  const user = await repo.createUser({ username: 'alice', email: 'alice@example.com', passwordHash });

  await repo.createRefreshToken({ userId: user.id, tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 3600_000) });

  const found = await repo.findRefreshTokenByHash('hash-1');
  assert.equal(found.user_id, user.id);
  const t1Id = found.id;
  assert.equal(await repo.findRefreshTokenByHash('nope'), null);

  // rotation: old token revoked, new token usable (returns true/false)
  const rotated = await repo.rotateRefreshToken({ oldTokenId: t1Id, userId: user.id, newTokenHash: 'hash-2', newExpiresAt: new Date(Date.now() + 3600_000) });
  assert.equal(rotated, true);
  assert.ok((await repo.findRefreshTokenByHash('hash-1')).revoked_at != null, 'old token revoked on rotation');
  assert.ok((await repo.findRefreshTokenByHash('hash-2')) != null, 'new token persisted');

  // explicit revocation
  const hash2 = await repo.findRefreshTokenByHash('hash-2');
  await repo.revokeRefreshToken(hash2.id);
  assert.ok((await repo.findRefreshTokenByHash('hash-2')).revoked_at != null);
  await repo.revokeRefreshTokenByHash('hash-2'); // idempotent

  // rotation of an already-revoked token is rejected (replay detection)
  const again = await repo.rotateRefreshToken({ oldTokenId: t1Id, userId: user.id, newTokenHash: 'hash-x', newExpiresAt: new Date(Date.now() + 3600_000) });
  assert.equal(again, false, 'cannot rotate a revoked token');
  assert.ok((await repo.findRefreshTokenByHash('hash-2')).revoked_at != null);
  await repo.revokeRefreshTokenByHash('hash-2'); // idempotent

  // revoke-all clears every token for the user
  await repo.createRefreshToken({ userId: user.id, tokenHash: 'hash-3', expiresAt: new Date(Date.now() + 3600_000) });
  await repo.createRefreshToken({ userId: user.id, tokenHash: 'hash-4', expiresAt: new Date(Date.now() + 3600_000) });
  await repo.revokeAllUserRefreshTokens(user.id);
  assert.ok((await repo.findRefreshTokenByHash('hash-3')).revoked_at != null);
  assert.ok((await repo.findRefreshTokenByHash('hash-4')).revoked_at != null);

  // expired-token cleanup removes only expired rows
  await repo.createRefreshToken({ userId: user.id, tokenHash: 'expired-1', expiresAt: new Date(Date.now() - 1000) });
  await repo.createRefreshToken({ userId: user.id, tokenHash: 'live-1', expiresAt: new Date(Date.now() + 3600_000) });
  await repo.deleteExpiredRefreshTokens();
  assert.equal(await repo.findRefreshTokenByHash('expired-1'), null, 'expired token purged');
  assert.ok((await repo.findRefreshTokenByHash('live-1')) != null, 'live token kept');
});

test('touchLastLogin updates the user timestamp', async () => {
  const { pool, repo, passwordHash } = await setup();
  const user = await repo.createUser({ username: 'alice', email: 'alice@example.com', passwordHash });
  await repo.touchLastLogin(user.id);
  const { rows } = await pool.query('SELECT last_login_at FROM users WHERE id = $1', [user.id]);
  assert.ok(rows[0].last_login_at, 'last login recorded');
});
