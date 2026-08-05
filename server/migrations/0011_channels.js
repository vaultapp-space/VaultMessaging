// ============================================================
// 0011 — Phase 5: channels
// ============================================================
// `chats` already carries `type='channel'`, `is_broadcast`, `username` and
// `linked_chat_id` from 0002. What is new here is the part that has to scale:
// where subscribers live, and how threads and moderation are recorded.
//
// **Subscribers get their own table, and it is partitioned.** Putting them in
// `chat_members` would work at a hundred subscribers and fall over at a
// million: every membership query in the product joins that table, and a
// channel's subscriber list is one to three orders of magnitude larger than
// any group's. Hash partitioning by chat_id keeps one popular channel from
// making every other chat's membership lookup slower.
//
// **Fanout writes O(1) rows per post.** A channel post is one `messages` row
// and one publish to `chan:{chatId}`; it does *not* write a `user_updates`
// row per subscriber, which for a large channel would be a million inserts
// for one post. Subscribers who were offline discover the post from
// `chats.last_message_at` and pull on open. This is the single most important
// difference between channels and groups in this codebase, and the reason
// Phase 0.5's fanout module was designed before it was needed.
//
// The 24-hour rule applies unchanged, and it is *most* surprising here: a
// channel is exactly the thing people expect to be an archive. Posts expire
// like everything else, so a quiet channel opens empty. That needs saying in
// the UI, not just in a comment — see `isEmpty` on the chat list.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Subscribers ────────────────────────────────────────────
-- Partitioned by chat_id so one large channel cannot degrade lookups for
-- every other chat. Sixteen partitions is arbitrary but sufficient: the point
-- is that the table is partitioned at all, and changing the count later is a
-- rewrite either way.

CREATE TABLE IF NOT EXISTS channel_subscribers (
    chat_id   uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    is_muted  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (chat_id, user_id)
) PARTITION BY HASH (chat_id);

DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS channel_subscribers_p%s
         PARTITION OF channel_subscribers
         FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
  END LOOP;
END $$;

-- "Which channels am I subscribed to" is the chat-list query, so it must not
-- scan every partition by user.
CREATE INDEX IF NOT EXISTS idx_channel_subscribers_user
    ON channel_subscribers (user_id);

-- ─── Threads (channel comments) ─────────────────────────────
-- A channel post's comments live in its linked discussion group, keyed by the
-- post they hang off. The counter is a table rather than a COUNT(*) because
-- the comment count is rendered on every post in the feed, and counting rows
-- per post per render is the classic way to make a feed slow.

CREATE TABLE IF NOT EXISTS message_threads (
    chat_id       uuid   NOT NULL,
    root_seq      bigint NOT NULL,
    replies_count int    NOT NULL DEFAULT 0,
    last_seq      bigint,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, root_seq),
    FOREIGN KEY (chat_id, root_seq) REFERENCES messages (chat_id, seq) ON DELETE CASCADE
);

-- ─── Admin log ──────────────────────────────────────────────
-- Who did what to a channel. Without this, "a post disappeared" and "someone
-- was banned" are unanswerable questions in a chat with several admins.
--
-- Deliberately *not* subject to the 24h rule: it records actions, not message
-- content, and an audit log that erased itself daily would not be one. The
-- details column must therefore never be used to stash message bodies —
-- that would smuggle content past the retention ceiling.

CREATE TABLE IF NOT EXISTS chat_admin_log (
    id         bigserial PRIMARY KEY,
    chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    action     text NOT NULL,
    target_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    details    jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_admin_log_chat
    ON chat_admin_log (chat_id, created_at DESC);

-- ─── Post attribution ───────────────────────────────────────
-- A channel post is attributed to the channel, not to the admin who wrote it,
-- unless the channel signs its posts. Storing the author regardless means the
-- admin log can still answer "who posted this" without the feed revealing it.

ALTER TABLE chats
    ADD COLUMN IF NOT EXISTS signatures_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS post_author text;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages DROP COLUMN IF EXISTS post_author;
ALTER TABLE chats DROP COLUMN IF EXISTS signatures_enabled;

DROP INDEX IF EXISTS idx_chat_admin_log_chat;
DROP TABLE IF EXISTS chat_admin_log;

DROP TABLE IF EXISTS message_threads;

DROP INDEX IF EXISTS idx_channel_subscribers_user;
DROP TABLE IF EXISTS channel_subscribers;
  `);
}
