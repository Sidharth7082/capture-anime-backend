// ============================================================================
// Symmetric encryption for tokens at rest (AES-256-GCM).
//
// MAL access/refresh tokens are secrets: they must never be stored in plain
// text and never leave the server. Encryption is non-negotiable here — if the
// MAL_TOKEN_ENCRYPTION_KEY is missing, token operations fail closed with a
// clear 503 instead of silently degrading to plaintext storage.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from './errors.js';

function key() {
  const raw = env.MAL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw ApiError.serviceUnavailable(
      'MAL token encryption is not configured (MAL_TOKEN_ENCRYPTION_KEY).',
    );
  }
  // Accept a 32-byte key as raw UTF-8, or as base64/hex of 32 bytes.
  let buf = Buffer.from(raw, 'utf8');
  if (buf.length !== 32) {
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length !== 32) {
    buf = Buffer.from(raw, 'hex');
  }
  if (buf.length !== 32) {
    throw ApiError.serviceUnavailable(
      'MAL_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (raw, base64 or hex).',
    );
  }
  return buf;
}

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Encrypt a string -> "iv:tag:ciphertext" (all base64url, no padding). */
export function encryptSecret(plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b) => b.toString('base64url');
  return `${b64(iv)}:${b64(tag)}:${b64(ciphertext)}`;
}

/** Decrypt a string produced by encryptSecret. */
export function decryptSecret(payload) {
  const [iv, tag, ciphertext] = String(payload).split(':');
  if (!iv || !tag || !ciphertext) {
    throw ApiError.serviceUnavailable('Stored MAL token is malformed.');
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    // Wrong key / tampered payload — fail closed, never return garbage.
    throw ApiError.serviceUnavailable('Failed to decrypt stored MAL token.');
  }
}
