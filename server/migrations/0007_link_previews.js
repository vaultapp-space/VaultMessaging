// ============================================================
// 0007 — Link previews
// ============================================================
// Cache of unfurled URL metadata, keyed by a hash of the URL.
//
// Cloud chats only. Unfurling a link from a secret chat would mean the server
// reading message content it is not supposed to see — and, worse, making an
// outbound request that reveals to a third party that a particular link was
// shared in an end-to-end encrypted conversation. That is a traffic-analysis
// leak, not just a privacy nicety, so secret chats never reach this table.
//
// Rows expire like everything else: `fetched_at` drives a TTL so a stale
// preview is re-fetched rather than served forever, and the reaper removes
// entries nothing references.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS link_previews (
    url_hash    bytea PRIMARY KEY,
    url         text NOT NULL,
    site_name   text,
    title       text,
    description text,
    image_url   text,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    -- Recorded so a URL that failed is not retried on every single send.
    error       text
);

CREATE INDEX IF NOT EXISTS idx_link_previews_fetched ON link_previews (fetched_at);

-- Attaches a preview to the message that mentioned the link.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS preview jsonb;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages DROP COLUMN IF EXISTS preview;
DROP INDEX IF EXISTS idx_link_previews_fetched;
DROP TABLE IF EXISTS link_previews;
  `);
}
