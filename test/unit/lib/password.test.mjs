import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

test('hash then verify roundtrip', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.ok(hash.startsWith('$2'));
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('wrong password rejected', async () => {
  const hash = await hashPassword('right');
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('different hashes for same password (salt)', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
});
