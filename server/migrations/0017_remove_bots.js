// ============================================================
// 0017 — Remove the bot platform
// ============================================================
// Bots are being dropped from the product. A bot receiving a message means
// the server can read it, which sits badly with a messenger whose one-to-one
// chats are end-to-end encrypted by default: the honest version of a bot here
// was always "works everywhere except the chats most people use".
//
// A separate migration rather than an edit to 0013, because 0013 has already
// been applied in production — an environment that has run a migration will
// never run it again, so editing one reaches fresh databases and silently
// misses every existing one.
//
// Everything here is a drop. `down` recreates the schema but not the data:
// bot tokens are unrecoverable by design (only hashes were ever stored), so a
// rollback gives back the tables and nothing that could authenticate against
// them. Restoring bots means restoring from a dump, not from this migration.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- The queue and both query tables hold message content; dropping them is also
-- the last of that content going away.
DROP INDEX IF EXISTS idx_inline_queries_expiry;
DROP TABLE IF EXISTS inline_queries;

DROP INDEX IF EXISTS idx_callback_queries_expiry;
DROP TABLE IF EXISTS callback_queries;

DROP INDEX IF EXISTS idx_bot_updates_expiry;
DROP INDEX IF EXISTS idx_bot_updates_pending;
DROP TABLE IF EXISTS bot_updates_queue;

DROP TABLE IF EXISTS bot_commands;

DROP INDEX IF EXISTS idx_bots_owner;
DROP TABLE IF EXISTS bots;

-- Any bot accounts themselves. They were users rows with no password and no
-- keys, so nothing can sign in as one; leaving them would put unusable
-- accounts in every user search.
DELETE FROM users WHERE is_bot = true;
ALTER TABLE users DROP COLUMN IF EXISTS is_bot;

-- Inline keyboards were a bot-only concept.
ALTER TABLE messages DROP COLUMN IF EXISTS reply_markup;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_markup jsonb;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bots (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,
    description  text,
    about        text,
    can_join_groups             boolean NOT NULL DEFAULT true,
    can_read_all_group_messages boolean NOT NULL DEFAULT false,
    supports_inline             boolean NOT NULL DEFAULT false,
    webhook_url    text,
    webhook_secret text,
    max_connections int NOT NULL DEFAULT 40,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots (owner_id);

CREATE TABLE IF NOT EXISTS bot_commands (
    bot_id      uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    command     text NOT NULL,
    description text NOT NULL,
    position    int NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_id, command)
);

CREATE TABLE IF NOT EXISTS bot_updates_queue (
    id           bigserial PRIMARY KEY,
    bot_id       uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    kind         text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    delivered_at timestamptz,
    attempts     int NOT NULL DEFAULT 0,
    next_retry_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bot_updates_pending
    ON bot_updates_queue (bot_id, id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bot_updates_expiry
    ON bot_updates_queue (expires_at);

CREATE TABLE IF NOT EXISTS callback_queries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id       uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id      uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_seq  bigint,
    data         text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    answered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_callback_queries_expiry
    ON callback_queries (expires_at);

CREATE TABLE IF NOT EXISTS inline_queries (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id     uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    results    jsonb
);
CREATE INDEX IF NOT EXISTS idx_inline_queries_expiry
    ON inline_queries (expires_at);
  `);
}
