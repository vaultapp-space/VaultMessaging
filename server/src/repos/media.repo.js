// ============================================================
// Vault — repos/media.repo.js
// ============================================================
// The ledger of uploaded public-media files. See migration 0020 for why it
// exists: without it, a file uploaded and never referenced is permanent and
// publicly readable, because the reaper only walks content rows and
// `canViewMediaFile` serves anything no row claims.
//
// Three calls: record on upload, claim on reference, and the reaper's orphan
// sweep.

// How long an uploaded file may sit unreferenced before it is treated as
// abandoned. Long enough to cover a composer left open mid-thought; short
// enough that the disk is not a public dumping ground.
export const ORPHAN_GRACE_SECONDS = 60 * 60;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function createMedia({ pool }) {
  return {
    pool,

    /** Called by the upload route, after the bytes are safely on disk. */
    async record(fileId, uploaderId, extension) {
      await this.pool.query(
        `INSERT INTO media_files (file_id, uploader_id, extension)
         VALUES ($1, $2, $3)
         ON CONFLICT (file_id) DO NOTHING`,
        [fileId, uploaderId, extension]
      );
    },

    /**
     * Mark a file as referenced by content. Idempotent, and deliberately
     * forgiving: a fileId with no ledger row (uploaded before 0020) is a
     * no-op rather than an error, because refusing here would break posting
     * with media that predates this table.
     *
     * `claimed_at IS NULL` in the WHERE keeps the first claim's timestamp
     * rather than moving it on every re-reference.
     */
    async claim(fileId) {
      // Non-UUID ids are ignored rather than rejected. `file_id` is a uuid
      // column, so passing anything else raises a Postgres type error — and
      // the story media schema is `additionalProperties: true` with no format
      // check on fileId, so a client can legitimately put an arbitrary string
      // there. Such a value cannot name a real ledger row (the upload route is
      // the only thing that creates them, always with randomUUID), so there is
      // nothing to claim and nothing to fail about. Failing here would take
      // down story creation for a value the story path itself permits.
      if (!UUID_RE.test(fileId ?? '')) return;
      await this.pool.query(
        `UPDATE media_files SET claimed_at = now()
          WHERE file_id = $1 AND claimed_at IS NULL`,
        [fileId]
      );
    },

    /**
     * Orphans: uploaded, never claimed, past the grace period.
     *
     * The three NOT EXISTS clauses are a safety net, not the mechanism. The
     * claim above is what normally clears a row; these re-check the content
     * tables so that a future content type whose author forgets to call
     * `claim()` loses its images at worst never, rather than an hour after
     * upload. A missed claim should be a no-op, not data loss.
     *
     * Batched for the same reason the posts reaper is: this runs inside the
     * 60s pass that /health watches, and a backlog must not turn one pass into
     * a long transaction.
     */
    async listOrphans(limit = 500) {
      const { rows } = await this.pool.query(
        `SELECT file_id, extension FROM media_files
          WHERE claimed_at IS NULL
            AND created_at < now() - ($1 || ' seconds')::interval
            AND NOT EXISTS (SELECT 1 FROM posts p
                             WHERE p.media->>'fileId' = media_files.file_id::text)
            AND NOT EXISTS (SELECT 1 FROM stories s
                             WHERE s.media->>'fileId' = media_files.file_id::text)
            AND NOT EXISTS (SELECT 1 FROM stickers st
                             WHERE st.file_id = media_files.file_id)
            AND NOT EXISTS (SELECT 1 FROM sticker_sets ss
                             WHERE ss.thumb_file_id = media_files.file_id)
          LIMIT $2`,
        [String(ORPHAN_GRACE_SECONDS), limit]
      );
      return rows;
    },

    /** Drop ledger rows by id. Called after their files are off the disk. */
    async forget(fileIds) {
      // Filtered for the same reason claim() is, but the stakes are higher
      // here: this is called from inside the reaper's 60s pass, and a type
      // error raised by one story's arbitrary fileId string would abort the
      // whole pass. Enough consecutive aborts and /health starts returning 503
      // for what is really one malformed field.
      const valid = fileIds.filter((id) => UUID_RE.test(id ?? ''));
      if (!valid.length) return 0;
      const { rowCount } = await this.pool.query(
        `DELETE FROM media_files WHERE file_id = ANY($1::uuid[])`,
        [valid]
      );
      return rowCount;
    },
  };
}
