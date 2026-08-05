// ============================================================
// 0013 — Phase 7: the bot platform
// ============================================================
// A bot is a `users` row with `is_bot = true`, plus a `bots` row holding what
// makes it a bot: a token, an owner, and what it is allowed to see.
//
// Reusing the users table is the decision that keeps this affordable. A bot
// can be a chat member, a message sender, a reaction author and a search
// result without any of those code paths learning what a bot is. The
// alternative — a parallel identity type — means auditing every join in the
// product for "…or a bot".
//
// Three things here are security-relevant and worth reading before changing:
//
//   1. **Only a token *hash* is stored.** The plaintext token is shown once at
//      creation and never again. A database read must not yield working
//      credentials for every bot on the instance.
//
//   2. **`can_read_all_group_messages` defaults to false.** By default a bot
//      in a group sees only messages addressed to it. Defaulting the other way
//      would turn every bot invite into a silent transcript feed, and users
//      would have no reason to expect it.
//
//   3. **Bots are cloud-only by construction.** A bot receiving a message
//      means the server can read it. There is no honest way to put a bot in a
//      secret chat, so the send path refuses it rather than quietly
//      downgrading the conversation.
//
// Retention: the update queue holds message copies, so it expires on the same
// 24-hour schedule as messages — the same reasoning as `user_updates` in 0010.
// Bot *registrations* and commands persist; they are configuration, not
// content.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Bot identity ───────────────────────────────────────────

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bots (
    user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 of the token. The plaintext is shown once and never stored:
    -- a dump of this table must not be a set of working credentials.
    token_hash   text NOT NULL UNIQUE,
    description  text,
    about        text,
    can_join_groups             boolean NOT NULL DEFAULT true,
    -- Privacy mode, off by default: a bot in a group sees only messages
    -- addressed to it unless its owner deliberately turns this on.
    can_read_all_group_messages boolean NOT NULL DEFAULT false,
    supports_inline             boolean NOT NULL DEFAULT false,
    webhook_url    text,
    webhook_secret text,
    max_connections int NOT NULL DEFAULT 40,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots (owner_id);

-- ─── Declared commands ──────────────────────────────────────
-- Configuration, not content: persists.

CREATE TABLE IF NOT EXISTS bot_commands (
    bot_id      uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    command     text NOT NULL,
    description text NOT NULL,
    position    int NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_id, command)
);

-- ─── The update queue ───────────────────────────────────────
-- What getUpdates long-polls and what the webhook worker drains.
--
-- These rows carry message content, so they expire like messages do. A queue
-- without an expiry is a second permanent copy of every conversation a bot
-- has ever been in — exactly the failure mode user_updates was designed to
-- avoid in 0010.

CREATE TABLE IF NOT EXISTS bot_updates_queue (
    id           bigserial PRIMARY KEY,
    bot_id       uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    kind         text NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    -- Set once the bot has confirmed receipt by asking for a later offset.
    delivered_at timestamptz,
    -- Webhook delivery bookkeeping. Retries back off; a bot whose endpoint is
    -- down must not become an infinite retry loop against someone else's
    -- server.
    attempts     int NOT NULL DEFAULT 0,
    next_retry_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bot_updates_pending
    ON bot_updates_queue (bot_id, id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bot_updates_expiry
    ON bot_updates_queue (expires_at);

-- ─── Callback queries ───────────────────────────────────────
-- A press on an inline keyboard button. Short-lived by nature: a callback
-- that has not been answered within the window is stale, and answering it
-- would attach a response to a message the user has long since scrolled past.

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

-- ─── Inline queries ─────────────────────────────────────────
-- "@botname something" typed into any chat. The query text is user input and
-- expires with everything else.

CREATE TABLE IF NOT EXISTS inline_queries (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id     uuid NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    -- The bot's answer, once it arrives. Cached so several users typing the
    -- same query do not each wake the bot.
    results    jsonb
);

CREATE INDEX IF NOT EXISTS idx_inline_queries_expiry
    ON inline_queries (expires_at);

-- ─── Message attribution ────────────────────────────────────
-- via_bot_id already exists from 0002 for inline results. This records which
-- inline keyboard a message carries, so a callback can be validated against
-- the message that actually offered the button.

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS reply_markup jsonb;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages DROP COLUMN IF EXISTS reply_markup;

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

ALTER TABLE users DROP COLUMN IF EXISTS is_bot;
  `);
}
