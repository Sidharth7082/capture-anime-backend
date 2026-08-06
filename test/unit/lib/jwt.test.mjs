import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  refreshTokenLifetimeMs,
} from '../../src/lib/jwt.js';
import { ApiError } from '../../src/lib/errors.js';

const user = { id: '00000000-0000-0000-0000-000000000001', username: 'alice', role: 'viewer' };

test('access token roundtrip carries claims', () => {
  const token = signAccessToken(user);
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.username, 'alice');
  assert.equal(payload.type, 'access');
  assert.ok(payload.exp > payload.iat);
});

test('refresh token roundtrip carries jti', () => {
  const token = signRefreshToken(user);
  const payload = verifyRefreshToken(token);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.type, 'refresh');
  assert.ok(payload.jti);
});

test('refresh token is rejected by access verification (type mismatch)', () => {
  const refresh = signRefreshToken(user);
  assert.throws(() => verifyAccessToken(refresh), ApiError);
});

test('tampered token rejected', () => {
  const token = signAccessToken(user);
  const tampered = `${token.slice(0, -2)}xx`;
  assert.throws(() => verifyAccessToken(tampered), ApiError);
});

test('garbage token rejected', () => {
  assert.throws(() => verifyAccessToken('not.a.jwt'), ApiError);
});

test('hashToken is a sha256 hex digest', () => {
  const hash = hashToken('secret-token-value');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashToken('secret-token-value'), hash);
  assert.notEqual(hashToken('other'), hash);
});

test('refreshTokenLifetimeMs returns a positive number', () => {
  assert.ok(refreshTokenLifetimeMs() > 0);
});
