// ============================================================
// Vault — Server-Side Cryptographic Utilities
// Only password hashing — the server NEVER touches E2EE keys
// ============================================================

import argon2 from 'argon2';

/**
 * Hash a password with argon2id (memory-hard, side-channel resistant).
 * @param {string} password - Plaintext password
 * @returns {Promise<string>} - Encoded hash string
 */
export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,  // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

/**
 * Verify a password against its argon2id hash.
 * @param {string} hash - Stored hash
 * @param {string} password - Plaintext password to verify
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hash, password) {
  return argon2.verify(hash, password);
}
