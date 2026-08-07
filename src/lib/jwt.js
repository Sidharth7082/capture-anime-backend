// JWT signing / verification + refresh-token hashing.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env, parseDuration } from '../config/env.js';
import { ApiError } from './errors.js';

const ALGORITHM = 'HS256';
// Issuer/audience pin the token to this service, so a token signed by another
// app sharing a secret (or a stale role claim) can't be replayed here.
const ISSUER = 'capture-anime-backend';
const AUDIENCE = 'capture-anime-api';

function sign(payload, secret, expiresIn) {
  return jwt.sign(payload, secret, {
    algorithm: ALGORITHM,
    expiresIn,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function signAccessToken(user) {
  return sign(
    { type: 'access', sub: user.id, username: user.username, role: user.role },
    env.JWT_ACCESS_SECRET,
    env.JWT_ACCESS_EXPIRES_IN,
  );
}

export function signRefreshToken(user) {
  // jti lets us correlate the DB row with the token during debugging.
  return sign(
    { type: 'refresh', sub: user.id, jti: crypto.randomUUID() },
    env.JWT_REFRESH_SECRET,
    env.JWT_REFRESH_EXPIRES_IN,
  );
}

function verify(token, secret, expectedType) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.type !== expectedType) throw new Error('wrong token type');
    return payload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
}

export function verifyAccessToken(token) {
  return verify(token, env.JWT_ACCESS_SECRET, 'access');
}

export function verifyRefreshToken(token) {
  return verify(token, env.JWT_REFRESH_SECRET, 'refresh');
}

/** Only the SHA-256 digest of a refresh token is ever persisted. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function accessTokenLifetimeMs() {
  return parseDuration(env.JWT_ACCESS_EXPIRES_IN);
}

export function refreshTokenLifetimeMs() {
  return parseDuration(env.JWT_REFRESH_EXPIRES_IN);
}
