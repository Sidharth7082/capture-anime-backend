// Password hashing — bcrypt (pure-JS implementation, no native build).
import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Precomputed hash of a throwaway random string, used to equalize login
// timing for unknown usernames. Generated once with the SAME cost as real
// passwords so a future BCRYPT_ROUNDS change can't reopen the timing side
// channel (a cheaper dummy would make unknown-username logins faster).
let dummyHashPromise = null;
export function dummyHash() {
  dummyHashPromise ??= bcrypt.hash(`timing-equalizer-${Math.random()}`, BCRYPT_ROUNDS);
  return dummyHashPromise;
}
