// ============================================================
// Vault — repos/users.repo.js
// ============================================================
// Users: identity records and lookup. The server stores no PII beyond a
// username — everything else here is opaque key material.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.

import crypto from 'node:crypto';

import config from '../config.js';

export function createUsers({ pool, dummySaltSecret = config.jwtSecret }) {
  return {
    pool,

  async createUser({ username, passwordHash, identityKey, signedPrekey, prekeySig, salt, encryptedVault = null }) {
    const res = await this.pool.query(
      `INSERT INTO users (username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault, created_at`,
      [username, passwordHash, identityKey, signedPrekey, prekeySig, salt, encryptedVault]
    );
    return res.rows[0];
  },

  async updateUserKeys(id, { identityKey, signedPrekey, prekeySig }) {
    const res = await this.pool.query(
      `UPDATE users SET identity_key = $1, signed_prekey = $2, prekey_sig = $3
       WHERE id = $4
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt`,
      [identityKey, signedPrekey, prekeySig, id]
    );
    return res.rows[0] || null;
  },

  async updateSignedPrekey(id, signedPrekey, prekeySig) {
    const res = await this.pool.query(
      `UPDATE users SET signed_prekey = $1, prekey_sig = $2
       WHERE id = $3
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt`,
      [signedPrekey, prekeySig, id]
    );
    return res.rows[0] || null;
  },

  async setEncryptedVault(id, encryptedVault) {
    const res = await this.pool.query(
      `UPDATE users SET encrypted_vault = $1
       WHERE id = $2
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault`,
      [encryptedVault, id]
    );
    return res.rows[0] || null;
  },

  async getUserByUsername(username) {
    const res = await this.pool.query(
      `SELECT id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault FROM users
       WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    return res.rows[0] || null;
  },

  async getUserById(id) {
    const res = await this.pool.query(
      `SELECT id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault FROM users
       WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  },

  async searchUsers(query, excludeUserId) {
    // Prefix match only (not "contains anywhere") — a substring match on a
    // short query returns most of the user table, effectively letting
    // anyone enumerate the entire userbase.
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const res = await this.pool.query(
      `SELECT id, username FROM users
       WHERE username ILIKE $1 ESCAPE '\\' AND id <> $2
       LIMIT 20`,
      [`${escaped}%`, excludeUserId]
    );
    return res.rows;
  },

  /**
   * A stand-in salt for a username that does not exist.
   *
   * The point is that /auth/salt answers identically whether or not the
   * account is real, so it cannot be used to enumerate users. That only holds
   * if the value is unguessable: this was keyed with the literal string
   * 'dummy_salt_key', which lives in a public repository — so anyone could
   * compute the dummy for any username, compare it to the response, and learn
   * exactly which accounts exist. The endpoint looked like it defended
   * against enumeration while defending against nothing.
   *
   * Keyed on the instance's own secret now, domain-separated so it is never
   * the same value as anything else derived from it.
   */
  getDummySalt(username) {
    return crypto.createHmac('sha256', dummySaltSecret)
      .update(`dummy-salt:${username}`)
      .digest('base64')
      .substring(0, 24);
  },
  };
}
