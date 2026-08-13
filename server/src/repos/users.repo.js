// ============================================================
// Vault — repos/users.repo.js
// ============================================================
// Users: identity records and lookup. The server stores no PII beyond a
// username — everything else here is opaque key material.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

  /**
   * Deletes an account and everything that belongs to it.
   *
   * **The media has to be collected before the row goes.** Almost every table
   * here cascades from `users`, and `posts`, `stories` and `media_files` all
   * reference files on disk — but a cascade-deleted row is never returned by
   * `DELETE ... RETURNING`, so deleting the user first makes those files
   * unreachable by anything, forever. Worse, the `media_files` ledger rows go
   * with them, so even the orphan sweep loses its record of what to remove.
   * The result is a permanently public file store belonging to an account
   * that no longer exists — which is the precise opposite of what someone
   * pressing "delete my account" is asking for.
   *
   * So: gather the file ids, delete the user, then unlink. Rows before files
   * in this direction rather than the reaper's files-before-rows, because the
   * user row is what makes the content reachable; once it is gone, a leftover
   * file is invisible rather than served. A crash between the two leaves files
   * the next deploy will not find, which is why the ids are gathered from
   * every table rather than only from posts.
   *
   * Returns false when there is no such user.
   */
  async deleteAccount(userId, { uploadsDir }) {
    const { rows: fileRows } = await this.pool.query(
      `SELECT media->>'fileId' AS file_id FROM posts
        WHERE author_id = $1 AND media IS NOT NULL
       UNION
       SELECT media->>'fileId' FROM stories
        WHERE user_id = $1 AND media IS NOT NULL
       UNION
       SELECT file_id::text FROM media_files
        WHERE uploader_id = $1`,
      [userId]
    );

    const { rowCount } = await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    if (rowCount === 0) return false;

    // Best-effort, and deliberately after the row. A file that fails to
    // unlink is no longer reachable through any route — the account it
    // belonged to does not exist — so it must not turn a completed deletion
    // into a failed request.
    const mediaDir = path.join(uploadsDir, 'media');
    for (const row of fileRows) {
      if (!row.file_id) continue;
      for (const extension of ['.webp', '.png', '.gif', '.webm']) {
        await fs.promises.unlink(path.join(mediaDir, `${row.file_id}${extension}`)).catch(() => {});
      }
    }

    return true;
  },
  };
}
