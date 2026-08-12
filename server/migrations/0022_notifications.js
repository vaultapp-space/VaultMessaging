// ============================================================
// 0022 — notifications for the public feed
// ============================================================
// Likes, replies, reposts and follows were invisible. Someone answering your
// post was something you could only discover by reopening the thread and
// noticing the count had moved, which nobody does — so on a feed where posts
// live 24 hours, most interactions were never seen at all by the person they
// were addressed to.
//
// **One row per event, written by the actor's own request.** Never per
// follower, never a fan-out: every event here has exactly one recipient (the
// author of the post, or the person being followed), so this stays O(1) on the
// write path, which is the invariant the whole feed design rests on. Anything
// that needs to notify many people belongs in a worker, not here.
//
// **They expire like everything else.** A notification about a post outlives
// its subject otherwise — you would tap "X liked your post" and land on
// nothing. `post_id` cascades, which handles that for the three post-shaped
// types; a follow has no post, so the table carries its own `expires_at` and
// the reaper collects both.
//
// **Self-actions are not stored at all**, rather than filtered on read. Liking
// your own post is not news, and a table that holds rows nobody will ever be
// shown is a table that grows for no reason.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS notifications (
    id         bigserial PRIMARY KEY,
    -- Who is being told. CASCADE: the notifications of a deleted account are
    -- meaningless and must not outlive it.
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Who did it. Also CASCADE — a notification naming a deleted account
    -- cannot be rendered, since the username is joined at read time.
    actor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('like', 'reply', 'repost', 'follow')),
    -- The post that was liked/replied to/reposted. NULL for a follow, which is
    -- the only kind not about a post.
    post_id    uuid REFERENCES posts(id) ON DELETE CASCADE,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

-- One notification per (recipient, actor, kind, post). Liking, unliking and
-- liking again is one event, not three — otherwise the bell is a weapon:
-- repeat the action and fill someone's list at no cost.
--
-- Two partial indexes rather than one UNIQUE ... NULLS NOT DISTINCT
-- constraint, which reads better and is what this was first written as. That
-- syntax is Postgres 15+; **production runs 14**, so it would have failed on
-- deploy while passing locally on 16. Check the server's version before using
-- anything newer than 14 here. (No backticks in this file: it is one big
-- template literal, and a stray one silently truncates the SQL — migration
-- 0019 hit exactly that.)
--
-- The second index is what makes follows idempotent: their post_id is NULL,
-- and a plain unique index treats every NULL as distinct, so follow/unfollow
-- /follow would notify three times.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_post
    ON notifications (user_id, actor_id, kind, post_id) WHERE post_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_nopost
    ON notifications (user_id, actor_id, kind) WHERE post_id IS NULL;

-- The list query: one user's notifications, newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);

-- The badge query. Partial, so it holds only what is actually unread rather
-- than every notification ever delivered.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications (user_id) WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_expiry
    ON notifications (expires_at);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_notifications_expiry;
DROP INDEX IF EXISTS idx_notifications_unread;
DROP INDEX IF EXISTS idx_notifications_user;
DROP INDEX IF EXISTS idx_notifications_event_nopost;
DROP INDEX IF EXISTS idx_notifications_event_post;
DROP TABLE IF EXISTS notifications;
  `);
}
