// ============================================================
// 0002 — Chat model
// ============================================================
// Gives conversations a real identity.
//
// Until now a "chat" was implied: a 1:1 conversation existed only as rows in
// encrypted_messages, and a group was addressed by the string `group-<uuid>`
// assembled in the client. Nothing could be attached to a conversation —
// no read state, no per-chat settings, no ordering, no stable id to put in a
// URL. This migration introduces `chats` and moves messages onto it.
//
// Retention is unchanged. `messages.expires_at` stays NOT NULL and the reaper
// keeps its current behaviour: every message is deleted 24 hours after it was
// sent, in cloud chats exactly as in secret ones. `chats` rows are durable —
// a conversation whose messages have expired remains in the list, empty.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- uuid_generate_v5 gives deterministic ids for private chats, so both
-- participants derive the same chat id without a lookup table and without a
-- race on who sends first.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  CREATE TYPE chat_type AS ENUM ('private','group','channel','saved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE chat_mode AS ENUM ('cloud','secret');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS chats (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type              chat_type NOT NULL,
    mode              chat_mode NOT NULL DEFAULT 'cloud',
    title             text,
    username          text UNIQUE,
    about             text,
    photo_id          uuid,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),

    -- Per-chat message counter. Allocated inside the send transaction, and
    -- what makes /a/c/<chatId>/<seq> deep links and read watermarks cheap.
    last_seq          bigint NOT NULL DEFAULT 0,

    -- Survives the message it refers to: it is the chat list's sort key, and
    -- the reaper must never rewrite it. See the empty-chat rule below.
    last_message_at   timestamptz,

    members_count     int NOT NULL DEFAULT 0,
    is_broadcast      boolean NOT NULL DEFAULT false,
    is_forum          boolean NOT NULL DEFAULT false,
    slow_mode_secs    int NOT NULL DEFAULT 0,

    -- Per-chat self-destruct. NULL means "use the 24h default". It can only
    -- ever shorten a message's life, never extend it — the ceiling is
    -- enforced here as well as in the send path.
    default_ttl_secs  int CHECK (default_ttl_secs IS NULL OR (default_ttl_secs > 0 AND default_ttl_secs <= 86400)),

    linked_chat_id    uuid REFERENCES chats(id) ON DELETE SET NULL,
    pts               bigint NOT NULL DEFAULT 0,

    -- Legacy bridge: groups created before this migration keep their join key
    -- so existing invite flows keep working until Phase 3 replaces them.
    join_key          text UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_chats_last_message_at ON chats (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_chats_type_mode ON chats (type, mode);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id      uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         text NOT NULL DEFAULT 'member',   -- owner|admin|member|restricted|banned
    rights       jsonb NOT NULL DEFAULT '{}'::jsonb,
    custom_title text,
    joined_at    timestamptz NOT NULL DEFAULT now(),
    invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);

-- Replaces the per-message delivered/read booleans. A watermark per user per
-- chat is one row to update instead of one per message, and it is what makes
-- numeric unread badges free rather than a count query.
CREATE TABLE IF NOT EXISTS chat_read_state (
    chat_id             uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_inbox_max_seq  bigint NOT NULL DEFAULT 0,
    read_outbox_max_seq bigint NOT NULL DEFAULT 0,
    unread_count        int NOT NULL DEFAULT 0,
    unread_mentions     int NOT NULL DEFAULT 0,
    unread_reactions    int NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_state_user ON chat_read_state (user_id);

-- Per-user, per-chat preferences. Split from chat_members because it applies
-- to private chats too, which have no membership rows in the same sense.
CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id       uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_until   timestamptz,
    archived      boolean NOT NULL DEFAULT false,
    pinned_order  int,
    ttl_secs      int CHECK (ttl_secs IS NULL OR (ttl_secs > 0 AND ttl_secs <= 86400)),
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_settings_user_active
    ON chat_settings (user_id) WHERE archived = false;

-- ─── messages ───────────────────────────────────────────────

ALTER TABLE encrypted_messages RENAME TO messages;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS chat_id          uuid REFERENCES chats(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS seq              bigint,
    ADD COLUMN IF NOT EXISTS type             smallint NOT NULL DEFAULT 0,
    -- Plaintext, and only ever populated for mode='cloud'. Secret chats leave
    -- this NULL and keep using ciphertext, exactly as before.
    ADD COLUMN IF NOT EXISTS body             text,
    ADD COLUMN IF NOT EXISTS entities         jsonb,
    ADD COLUMN IF NOT EXISTS media            jsonb,
    ADD COLUMN IF NOT EXISTS reply_to_seq     bigint,
    ADD COLUMN IF NOT EXISTS thread_root_seq  bigint,
    ADD COLUMN IF NOT EXISTS fwd_from_chat    uuid,
    ADD COLUMN IF NOT EXISTS fwd_from_seq     bigint,
    ADD COLUMN IF NOT EXISTS fwd_from_name    text,
    ADD COLUMN IF NOT EXISTS fwd_date         timestamptz,
    ADD COLUMN IF NOT EXISTS via_bot_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS edited_at        timestamptz,
    ADD COLUMN IF NOT EXISTS deleted_at       timestamptz,
    ADD COLUMN IF NOT EXISTS grouped_id       bigint,
    ADD COLUMN IF NOT EXISTS scheduled_at     timestamptz,
    ADD COLUMN IF NOT EXISTS views            int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS forwards         int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS client_random_id bigint,
    ADD COLUMN IF NOT EXISTS pinned_at        timestamptz,
    ADD COLUMN IF NOT EXISTS pinned_by        uuid REFERENCES users(id) ON DELETE SET NULL;

-- recipient_id is superseded by chat_id, and message_number only means
-- anything for a ratcheted (secret) message. expires_at is deliberately
-- untouched: it stays NOT NULL.
ALTER TABLE messages ALTER COLUMN recipient_id   DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN message_number DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq
    ON messages (chat_id, seq) WHERE chat_id IS NOT NULL AND seq IS NOT NULL;

-- Makes a retried send idempotent rather than duplicating the message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sender_random
    ON messages (sender_id, client_random_id) WHERE client_random_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_chat_sent
    ON messages (chat_id, sent_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_scheduled
    ON messages (chat_id, scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_grouped
    ON messages (grouped_id) WHERE grouped_id IS NOT NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_messages_grouped;
DROP INDEX IF EXISTS idx_messages_scheduled;
DROP INDEX IF EXISTS idx_messages_chat_sent;
DROP INDEX IF EXISTS idx_messages_sender_random;
DROP INDEX IF EXISTS idx_messages_chat_seq;

ALTER TABLE messages
    DROP COLUMN IF EXISTS chat_id,
    DROP COLUMN IF EXISTS seq,
    DROP COLUMN IF EXISTS type,
    DROP COLUMN IF EXISTS body,
    DROP COLUMN IF EXISTS entities,
    DROP COLUMN IF EXISTS media,
    DROP COLUMN IF EXISTS reply_to_seq,
    DROP COLUMN IF EXISTS thread_root_seq,
    DROP COLUMN IF EXISTS fwd_from_chat,
    DROP COLUMN IF EXISTS fwd_from_seq,
    DROP COLUMN IF EXISTS fwd_from_name,
    DROP COLUMN IF EXISTS fwd_date,
    DROP COLUMN IF EXISTS via_bot_id,
    DROP COLUMN IF EXISTS edited_at,
    DROP COLUMN IF EXISTS deleted_at,
    DROP COLUMN IF EXISTS grouped_id,
    DROP COLUMN IF EXISTS scheduled_at,
    DROP COLUMN IF EXISTS views,
    DROP COLUMN IF EXISTS forwards,
    DROP COLUMN IF EXISTS client_random_id,
    DROP COLUMN IF EXISTS pinned_at,
    DROP COLUMN IF EXISTS pinned_by;

-- Restoring NOT NULL would fail on any row the new model left null, so the
-- down path only restores the shape the baseline created on a fresh database.
UPDATE messages SET recipient_id = sender_id WHERE recipient_id IS NULL;
UPDATE messages SET message_number = 0 WHERE message_number IS NULL;
ALTER TABLE messages ALTER COLUMN recipient_id   SET NOT NULL;
ALTER TABLE messages ALTER COLUMN message_number SET NOT NULL;

ALTER TABLE messages RENAME TO encrypted_messages;

DROP TABLE IF EXISTS chat_settings;
DROP TABLE IF EXISTS chat_read_state;
DROP TABLE IF EXISTS chat_members;
DROP TABLE IF EXISTS chats;

DROP TYPE IF EXISTS chat_mode;
DROP TYPE IF EXISTS chat_type;
  `);
}
