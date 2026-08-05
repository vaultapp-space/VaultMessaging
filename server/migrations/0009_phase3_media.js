// ============================================================
// 0009 — Phase 3 tail: chat themes and view-once media
// ============================================================
// The remaining Phase 3 features that need storage. Albums need none:
// `messages.grouped_id` already exists from 0002 and albums are a rendering
// decision on top of it. Live location is deliberately not built.
//
// Both additions inherit the 24-hour rule, and view-once is worth spelling
// out because it looks like an exception and is not: it is *not* a shorter
// TTL. The message still expires on the normal schedule; viewing it simply
// clears its content early, and the row survives as a tombstone so the
// transcript keeps its shape.
//
// Themes are the one thing here deliberately exempt from expiry: a per-user
// preference on `chat_settings`, not message content, so it expires with the
// chat rather than with anything sent in it.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Chat themes ────────────────────────────────────────────
-- Per-user *and* per-chat: picking a theme for a conversation must not push
-- it onto the other participant, which is how Telegram behaves for the
-- one-sided case and is also the only version that needs no permission model.

ALTER TABLE chat_settings
    ADD COLUMN IF NOT EXISTS theme text;

-- ─── View-once media ────────────────────────────────────────

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false;

-- Who has opened what. Needed for two separate reasons: so a second look by
-- the same person is still allowed (closing the app must not destroy it), and
-- so the sender can be told it was seen.
CREATE TABLE IF NOT EXISTS message_views (
    chat_id   uuid   NOT NULL,
    seq       bigint NOT NULL,
    user_id   uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, seq, user_id),
    FOREIGN KEY (chat_id, seq) REFERENCES messages (chat_id, seq) ON DELETE CASCADE
);

  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP TABLE IF EXISTS message_views;
ALTER TABLE messages DROP COLUMN IF EXISTS view_once;

ALTER TABLE chat_settings DROP COLUMN IF EXISTS theme;
  `);
}
