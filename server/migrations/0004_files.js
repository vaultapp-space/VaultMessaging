// ============================================================
// 0004 — Files
// ============================================================
// `attachments` becomes `files`, and gains the metadata the chat model needs.
//
// Why rename: an attachment is a thing hanging off a message, which is what
// it was. A file is a thing that can be referenced by several messages —
// forwarded, re-shared, sent to a second chat — without being re-uploaded.
// That distinction is what `ref_count` and `sha256` exist to support.
//
// Retention is unchanged and applies here too: `expires_at` stays NOT NULL.
// A file must never outlive the message that carried it, so the invariant to
// preserve is that a file's expiry is always >= the expiry of every message
// referencing it. Forwarding extends the file's expiry (still clamped to the
// 24h ceiling); it never removes it.
//
// The encrypted chunk path is untouched. Secret chats keep uploading through
// chunks.routes.js exactly as before; `is_encrypted` records which kind of
// file a row is so the download path knows whether to expect ciphertext.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
ALTER TABLE attachments RENAME TO files;
ALTER TABLE attachment_allowed_users RENAME TO file_allowed_users;
ALTER TABLE file_allowed_users RENAME COLUMN attachment_id TO file_id;

ALTER TABLE files
    -- Content address. Lets a re-send of identical bytes reuse the stored
    -- file instead of uploading it again.
    ADD COLUMN IF NOT EXISTS sha256      text,
    ADD COLUMN IF NOT EXISTS size_bytes  bigint,
    ADD COLUMN IF NOT EXISTS width       int,
    ADD COLUMN IF NOT EXISTS height      int,
    ADD COLUMN IF NOT EXISTS duration_ms int,
    -- Small inline preview so a chat list or a media grid can render without
    -- fetching (and, for secret chats, without decrypting) the whole file.
    ADD COLUMN IF NOT EXISTS thumb_bytes bytea,
    -- True for the chunked E2EE path, false for a cloud file stored as-is.
    ADD COLUMN IF NOT EXISTS is_encrypted boolean NOT NULL DEFAULT true,
    -- How many messages point at this file. A forward increments it so the
    -- original expiring does not delete bytes another chat still shows.
    ADD COLUMN IF NOT EXISTS ref_count   int NOT NULL DEFAULT 1;

-- Existing rows are all from the encrypted chunk path.
UPDATE files SET is_encrypted = true WHERE is_encrypted IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_expires ON files (expires_at);
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_file_allowed_users_user ON file_allowed_users (user_id);

-- The old index name referred to a table that no longer exists.
DROP INDEX IF EXISTS idx_attachments_expires;
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_file_allowed_users_user;
DROP INDEX IF EXISTS idx_files_sha256;
DROP INDEX IF EXISTS idx_files_expires;

ALTER TABLE files
    DROP COLUMN IF EXISTS sha256,
    DROP COLUMN IF EXISTS size_bytes,
    DROP COLUMN IF EXISTS width,
    DROP COLUMN IF EXISTS height,
    DROP COLUMN IF EXISTS duration_ms,
    DROP COLUMN IF EXISTS thumb_bytes,
    DROP COLUMN IF EXISTS is_encrypted,
    DROP COLUMN IF EXISTS ref_count;

ALTER TABLE file_allowed_users RENAME COLUMN file_id TO attachment_id;
ALTER TABLE file_allowed_users RENAME TO attachment_allowed_users;
ALTER TABLE files RENAME TO attachments;

CREATE INDEX IF NOT EXISTS idx_attachments_expires ON attachments (expires_at);
  `);
}
