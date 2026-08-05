// ============================================================
// 0006 — Phase 2: deletion, pins, drafts, blocking, search
// ============================================================
// Everything here hangs off the chat model established in 0002, and all of it
// inherits the 24-hour rule: nothing added below outlives the message or chat
// it belongs to.
//
// Two deletion semantics, deliberately different:
//
//   delete for everyone → `messages.deleted_at` is stamped. The row survives
//                         until the reaper takes it, so the tombstone can be
//                         broadcast and clients can replace the text rather
//                         than leaving a hole in the transcript.
//   delete for me       → a row in `message_deleted_for`. Nobody else's view
//                         changes, which is the entire point.
//
// Search is a generated tsvector over `body`, so it only ever covers cloud
// chats. Secret chats have no body column populated and are excluded by
// construction rather than by a filter someone could forget.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Per-user deletion ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS message_deleted_for (
    chat_id    uuid NOT NULL,
    seq        bigint NOT NULL,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, seq, user_id),
    FOREIGN KEY (chat_id, seq) REFERENCES messages (chat_id, seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_deleted_for_user
    ON message_deleted_for (user_id);

-- ─── Pins ───────────────────────────────────────────────────
-- pinned_at / pinned_by already exist on messages from 0002; this is the
-- index that makes "show pinned messages in this chat" cheap.

CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON messages (chat_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- ─── Drafts ─────────────────────────────────────────────────
-- Cloud-synced, so an unsent message follows you between devices. Secret
-- chats keep drafts client-side: a draft is plaintext by nature, and storing
-- one server-side for an E2EE conversation would leak exactly the content
-- that conversation exists to protect.

CREATE TABLE IF NOT EXISTS drafts (
    chat_id      uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         text NOT NULL,
    entities     jsonb,
    reply_to_seq bigint,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts (user_id);

-- ─── Blocking ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);

-- ─── Presence ───────────────────────────────────────────────
-- Live presence lives in Redis (see realtime/registry.js); this is the
-- durable "last seen" fallback for a user who is currently offline.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
    -- 'everyone' | 'contacts' | 'nobody'. Presence is the one signal users
    -- most often want to withhold, so it is switchable from the start rather
    -- than retrofitted.
    ADD COLUMN IF NOT EXISTS presence_privacy text NOT NULL DEFAULT 'everyone';

-- ─── Global search ──────────────────────────────────────────
-- Generated, so it can never drift from the body it indexes. 'simple' rather
-- than a language configuration: messages are short, multilingual, and
-- stemming English rules over them would hurt more than help.

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN (search_tsv);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_messages_search;
ALTER TABLE messages DROP COLUMN IF EXISTS search_tsv;

ALTER TABLE users
    DROP COLUMN IF EXISTS last_seen_at,
    DROP COLUMN IF EXISTS presence_privacy;

DROP INDEX IF EXISTS idx_blocks_blocked;
DROP TABLE IF EXISTS blocks;

DROP INDEX IF EXISTS idx_drafts_user;
DROP TABLE IF EXISTS drafts;

DROP INDEX IF EXISTS idx_messages_pinned;

DROP INDEX IF EXISTS idx_message_deleted_for_user;
DROP TABLE IF EXISTS message_deleted_for;
  `);
}
