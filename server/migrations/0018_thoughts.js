// ============================================================
// 0018 — Thoughts (public posts)
// ============================================================
// The first surface in this product where a user addresses *strangers* rather
// than a chat they are a member of. Everything else here — messages, groups,
// even channels — is read through a membership check. A post is visible to
// everyone unless a block or mute says otherwise.
//
// **Why a new table and not chats+messages.** Channels look like a feed and
// roughly the right shape is already there, but reuse fails on three counts:
//
//   1. `seq`. A channel post takes its sequence number from a per-chat
//      counter, so a single "global feed" chat would serialise every post in
//      the product through one row. One channel per author avoids that but
//      puts a `chats` row in the chat list for every posting user.
//   2. Opposite default visibility. Every read path on `messages` is gated by
//      "is the caller a member of this chat". Putting default-public rows in
//      that table means any query that loses its chat_id predicate becomes a
//      leak — in either direction.
//   3. `messages` holds secret-chat ciphertext. A global, non-chat-scoped
//      SELECT over it is one missing WHERE away from returning rows the
//      server is not supposed to be able to read.
//
// **The 24h rule is what makes this cheap.** `posts` never holds more than a
// day of content, which is why a chronological global timeline needs two
// b-tree indexes and no fanout-on-write, no materialised feeds, no sharding.
// The expiry is not a limitation being worked around; it is the load-bearing
// beam. It also means expired rows are always the *oldest* rows, so they sit
// at the tail of a `created_at DESC` scan and are never touched on page one.
//
// Moderation lands separately in 0019 so the takedown model can change
// without touching the content DDL.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS posts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    body          text,
    -- Shaped strictly by the route schema: { fileId, mimeType, width, height }
    -- with additionalProperties:false. Deliberately tighter than stories.media,
    -- which accepts arbitrary JSON that later reaches an <img src>.
    media         jsonb,

    -- Flat threading, depth 2. reply_to_id is the immediate parent (for
    -- attribution), root_id is the top-level post the thread query keys on.
    -- Fixed depth keeps reaping and cascade behaviour analysable.
    reply_to_id   uuid REFERENCES posts(id) ON DELETE CASCADE,
    root_id       uuid REFERENCES posts(id) ON DELETE CASCADE,

    -- A repost is itself a posts row, so it interleaves into the timeline with
    -- no special case. body IS NULL -> pure repost; body present -> quote post.
    repost_of_id  uuid REFERENCES posts(id) ON DELETE CASCADE,

    -- Denormalised. Rendered on every card, and counting per card per render
    -- is the classic way to make a feed slow.
    likes_count   int NOT NULL DEFAULT 0,
    replies_count int NOT NULL DEFAULT 0,
    reposts_count int NOT NULL DEFAULT 0,

    created_at    timestamptz NOT NULL DEFAULT now(),
    -- NOT NULL and clamped in the repo, like every other content table here.
    expires_at    timestamptz NOT NULL,

    -- Operator takedown: a tombstone, not a delete. Body and media are blanked
    -- so no content survives, but the row remains so reports resolve against
    -- it and the ordinary reaper removes it within the day.
    removed_at    timestamptz,

    CONSTRAINT posts_have_content
      CHECK (body IS NOT NULL OR media IS NOT NULL OR repost_of_id IS NOT NULL
             OR removed_at IS NOT NULL),
    CONSTRAINT posts_body_length CHECK (body IS NULL OR char_length(body) <= 500),
    CONSTRAINT posts_root_pairing CHECK ((reply_to_id IS NULL) = (root_id IS NULL)),
    CONSTRAINT posts_no_self_ref
      CHECK (id <> reply_to_id AND id <> root_id AND id <> repost_of_id)
);

-- The global timeline. Partial on exactly its working set: top-level,
-- non-removed posts. A takedown drops out of it and replies never enter it.
-- (created_at, id) DESC is the keyset cursor — created_at alone is not unique,
-- and a keyset on a non-unique column skips or repeats rows at page edges.
CREATE INDEX IF NOT EXISTS idx_posts_global
    ON posts (created_at DESC, id DESC)
    WHERE reply_to_id IS NULL AND removed_at IS NULL;

-- The Following tab and the profile page.
CREATE INDEX IF NOT EXISTS idx_posts_author
    ON posts (author_id, created_at DESC, id DESC)
    WHERE reply_to_id IS NULL AND removed_at IS NULL;

-- Thread reads.
CREATE INDEX IF NOT EXISTS idx_posts_root
    ON posts (root_id, created_at) WHERE root_id IS NOT NULL;

-- The reaper.
CREATE INDEX IF NOT EXISTS idx_posts_expiry ON posts (expires_at);

-- One pure repost per user per post. A quote post carries a body and is an
-- ordinary post, so it is not deduplicated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_repost_unique
    ON posts (author_id, repost_of_id)
    WHERE repost_of_id IS NOT NULL AND body IS NULL;

CREATE TABLE IF NOT EXISTS post_likes (
    post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
-- The PK already answers "did this user like this post" when post_id is known,
-- which is the timeline's LEFT JOIN. This covers the reverse direction and
-- keeps the cascade from users cheap.
CREATE INDEX IF NOT EXISTS idx_post_likes_user ON post_likes (user_id);

-- Shaped deliberately like blocks (0006_phase2.js): two user ids, a timestamp,
-- a composite PK, a reverse index, a self-reference CHECK. A reviewer reading
-- this should recognise it immediately.
--
-- One-directional and public, unlike contacts (0015), which are one-directional
-- and private. Different feature; do not merge them.
CREATE TABLE IF NOT EXISTS follows (
    follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT no_self_follow CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);

-- Mute is not block. Block is a safety control that also stops DMs and is
-- symmetric in effect; mute is one-way, silent, and feed-only.
--
-- Named user_mutes because is_muted already means two other things in this
-- schema (channel_subscribers, voice_chat_participants).
--
-- Server-side rather than client-side on purpose: a client-side mute still
-- ships the content over the wire, so "I don't want to see this" would be
-- cosmetic. Keyword filters are the opposite call — those stay on the client,
-- because a server-side keyword list is a plaintext record of what a named
-- person finds upsetting, which is the most sensitive thing this product
-- could choose to store.
CREATE TABLE IF NOT EXISTS user_mutes (
    muter_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (muter_id, muted_id),
    CONSTRAINT no_self_mute CHECK (muter_id <> muted_id)
);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP TABLE IF EXISTS user_mutes;
DROP INDEX IF EXISTS idx_follows_followee;
DROP TABLE IF EXISTS follows;
DROP INDEX IF EXISTS idx_post_likes_user;
DROP TABLE IF EXISTS post_likes;
DROP INDEX IF EXISTS idx_posts_repost_unique;
DROP INDEX IF EXISTS idx_posts_expiry;
DROP INDEX IF EXISTS idx_posts_root;
DROP INDEX IF EXISTS idx_posts_author;
DROP INDEX IF EXISTS idx_posts_global;
DROP TABLE IF EXISTS posts;
  `);
}
