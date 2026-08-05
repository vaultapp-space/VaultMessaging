// ============================================================
// Vault — repos/attachments.repo.js
// ============================================================
// File metadata, per-recipient authorisation, and reference counting.
//
// The bytes live on disk in uploads/; only the bookkeeping is here. Two
// invariants matter:
//
//   - A file's expiry is always >= the expiry of every message referencing
//     it, so a file never disappears while a visible message still points at
//     it. Forwarding extends the expiry rather than resetting it.
//   - `expires_at` is NOT NULL. The 24h rule covers attachments exactly as it
//     covers messages; there is no such thing as a permanent upload.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.

import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';

export function createAttachments({ pool, uploadsDir }) {
  return {
    pool,
    uploadsDir,

  async saveAttachment(filename, mimeType, totalChunksOrCiphertext = '', burnOnRead = false, ownerId = null) {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    
    let totalChunks = 1;
    let ciphertext = '';
    
    if (typeof totalChunksOrCiphertext === 'number') {
      totalChunks = totalChunksOrCiphertext;
    } else {
      ciphertext = totalChunksOrCiphertext;
    }
    
    // Save metadata
    await this.pool.query(
      `INSERT INTO files (id, filename, mime_type, total_chunks, uploaded_chunks, burn_on_read, owner_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, filename, mimeType, totalChunks, 0, burnOnRead, ownerId, expiresAt]
    );

    // Save owner as allowed user
    if (ownerId) {
      await this.authorizeAttachmentUser(id, ownerId);
    }

    // Write chunk 0 if ciphertext is provided immediately
    if (ciphertext) {
      await this.saveChunk(id, 0, ciphertext);
    }

    return id;
  },

  async getAttachment(id) {
    const res = await this.pool.query(
      `SELECT * FROM files WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    const allowed = await this.pool.query(
      `SELECT user_id FROM file_allowed_users WHERE file_id = $1`,
      [id]
    );
    const allowedUsers = new Set(allowed.rows.map(r => r.user_id));

    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      totalChunks: row.total_chunks,
      uploadedChunks: row.uploaded_chunks,
      burn_on_read: row.burn_on_read,
      owner_id: row.owner_id,
      expires_at: row.expires_at,
      allowed_users: allowedUsers
    };
  },

  async authorizeAttachmentUser(attachmentId, userId) {
    await this.pool.query(
      `INSERT INTO file_allowed_users (file_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [attachmentId, userId]
    );
  },

  async revokeAttachmentUser(attachmentId, userId) {
    await this.pool.query(
      `DELETE FROM file_allowed_users
       WHERE file_id = $1 AND user_id = $2`,
      [attachmentId, userId]
    );
  },

  async countRemainingRecipients(attachmentId, ownerId) {
    if (ownerId) {
      const res = await this.pool.query(
        `SELECT COUNT(*) as count FROM file_allowed_users
         WHERE file_id = $1 AND user_id <> $2`,
        [attachmentId, ownerId]
      );
      return parseInt(res.rows[0].count, 10);
    } else {
      const res = await this.pool.query(
        `SELECT COUNT(*) as count FROM file_allowed_users
         WHERE file_id = $1`,
        [attachmentId]
      );
      return parseInt(res.rows[0].count, 10);
    }
  },

  async saveChunk(id, index, ciphertext) {
    const filePath = path.join(this.uploadsDir, `${id}_${index}.txt`);
    await fs.promises.writeFile(filePath, ciphertext, 'utf8');

    // Update chunk metadata
    await this.pool.query(
      `UPDATE files
       SET uploaded_chunks = uploaded_chunks + 1,
           total_chunks = GREATEST(total_chunks, $2 + 1)
       WHERE id = $1`,
      [id, index]
    );
  },

  async getChunk(id, index) {
    const filePath = path.join(this.uploadsDir, `${id}_${index}.txt`);
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
      return null;
    }
  },

  async deleteAttachment(id) {
    const attachment = await this.getAttachment(id);
    if (!attachment) return;

    // Delete chunks from disk
    for (let i = 0; i < attachment.totalChunks; i++) {
      const filePath = path.join(this.uploadsDir, `${id}_${i}.txt`);
      await fs.promises.unlink(filePath).catch(() => {});
    }

    // Delete database records
    await this.pool.query(`DELETE FROM files WHERE id = $1`, [id]);
  },

  // ─── Content addressing & reference counting ────────────
  // The reason `attachments` became `files`: one stored blob can back several
  // messages. A forward should not re-upload bytes the server already has.

  // Finds an existing file with identical bytes that this user may reference.
  // Scoped to the owner deliberately: matching on hash alone would let anyone
  // who guessed a hash claim a file they never had access to.
  async findByHash(sha256, ownerId) {
    if (!sha256) return null;
    const res = await this.pool.query(
      `SELECT * FROM files
        WHERE sha256 = $1 AND owner_id = $2 AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [sha256, ownerId]
    );
    return res.rows[0] || null;
  },

  // Adds a reference and pushes the expiry out to cover the new message,
  // clamped to the 24h ceiling so a chain of forwards can never make a file
  // immortal — the failure mode this clamp exists to prevent.
  async addReference(fileId, expiresAt) {
    const res = await this.pool.query(
      `UPDATE files
          SET ref_count = ref_count + 1,
              expires_at = LEAST(
                GREATEST(expires_at, $2::timestamptz),
                now() + interval '24 hours'
              )
        WHERE id = $1
        RETURNING id, ref_count, expires_at`,
      [fileId, expiresAt]
    );
    return res.rows[0] || null;
  },

  // Drops a reference. The row is not deleted here even at zero — the reaper
  // owns deletion, and it removes the bytes from disk at the same time.
  // Deleting here would orphan the files on disk.
  async releaseReference(fileId) {
    const res = await this.pool.query(
      `UPDATE files SET ref_count = GREATEST(ref_count - 1, 0)
        WHERE id = $1
        RETURNING id, ref_count`,
      [fileId]
    );
    return res.rows[0] || null;
  },

  async setMetadata(fileId, { sha256 = null, sizeBytes = null, width = null,
                              height = null, durationMs = null, isEncrypted = null } = {}) {
    const res = await this.pool.query(
      `UPDATE files
          SET sha256      = COALESCE($2, sha256),
              size_bytes  = COALESCE($3, size_bytes),
              width       = COALESCE($4, width),
              height      = COALESCE($5, height),
              duration_ms = COALESCE($6, duration_ms),
              is_encrypted = COALESCE($7, is_encrypted)
        WHERE id = $1
        RETURNING *`,
      [fileId, sha256, sizeBytes, width, height, durationMs, isEncrypted]
    );
    return res.rows[0] || null;
  },
  };
}
