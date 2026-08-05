// ============================================================
// 0005 — Reactions
// ============================================================
// The first Phase 2 feature, and the one that establishes the pattern the
// rest follow.
//
// Reactions work in **both** chat modes, which is the whole point of the
// `t:'op'` envelope. In a cloud chat reacting is an HTTP call that writes a
// row here. In a secret chat the identical envelope is encrypted through the
// existing ratchet, sent as an ordinary message, and applied client-side —
// the server stores a reaction row only for chats it can already read.
// Either way the composer and the message list see the same thing.
//
// The denormalised `messages.reactions` column exists so rendering a message
// list never needs a join or an N+1. It is updated in the same transaction as
// the reactions row, so the two cannot drift.
//
// Retention: reactions hang off a message via ON DELETE CASCADE, so the
// reaper removing an expired message removes its reactions with it. No
// separate expiry, and no way for a reaction to outlive what it reacted to.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- The (chat_id, seq) unique index from 0002 was partial, and Postgres will not
-- let a foreign key reference a partial index. Replaced with a plain unique
-- index, which gives the identical guarantee here: NULLs are treated as
-- distinct, so the legacy secret messages that carry no chat_id/seq are still
-- free to coexist, while any pair of real values stays unique.
DROP INDEX IF EXISTS idx_messages_chat_seq;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages (chat_id, seq);

CREATE TABLE IF NOT EXISTS reactions (
    chat_id    uuid NOT NULL,
    seq        bigint NOT NULL,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- A unicode emoji, or 'custom:<sticker_id>' once custom emoji land.
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, seq, user_id, emoji),
    -- Ties the reaction to the message's (chat_id, seq) identity, so an
    -- expiring message takes its reactions with it.
    FOREIGN KEY (chat_id, seq) REFERENCES messages (chat_id, seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions (user_id);

-- Denormalised summary: [{ emoji, count, users: [...] }]. Read directly by
-- the message list so rendering never joins.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages DROP COLUMN IF EXISTS reactions;
DROP INDEX IF EXISTS idx_reactions_user;
DROP INDEX IF EXISTS idx_reactions_message;
DROP TABLE IF EXISTS reactions;

-- Restore the partial index 0002 created.
DROP INDEX IF EXISTS idx_messages_chat_seq;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq
    ON messages (chat_id, seq) WHERE chat_id IS NOT NULL AND seq IS NOT NULL;
  `);
}
