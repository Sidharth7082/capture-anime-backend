// Generates strong JWT secrets for .env (crypto-random, 64 hex chars).
//
//   node scripts/generate-secrets.mjs
//
import crypto from 'node:crypto';

function secret() {
  return crypto.randomBytes(32).toString('hex');
}

console.log(`JWT_ACCESS_SECRET=${secret()}`);
console.log(`JWT_REFRESH_SECRET=${secret()}`);
console.log('\n# Add these to .env, then restart the API.');
