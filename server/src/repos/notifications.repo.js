// ============================================================
// Vault — repos/notifications.repo.js
// ============================================================
// Likes, replies, reposts and follows, told to the one person each concerns.
//
// The invariant that matters: **every write here is a single row for a single
// recipient.** Each of these events has exactly one interested party — the
// author of the post, or the person being followed — so notifying is O(1) and
// belongs inline on the request that caused it. The moment something needs to
// tell many people (a post to your followers, say) it stops being this and
// becomes a worker; see the note in realtime/feed-ticker.js.

// Matches the post TTL. A notification about a post must not outlive it, or
// tapping it lands on nothing.
const NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

export function createNotifications({ pool }) {
  return {
    pool,

    /**
     * Records an event and returns the row, or null if nothing was written.
     *
     * Null happens for two ordinary reasons, neither of them an error: the
     * actor is the recipient (liking your own post is not news), or this exact
     * event already exists (liking, unliking and liking again is one event —
     * without that, repeating an action is a free way to fill someone's list).
     *
     * `expires_at` is clamped to the post's own expiry when there is a post,
     * so the notification cannot outlive its subject even if the post was
     * already most of the way through its day.
     */
    async record({ userId, actorId, kind, postId = null }) {
      if (!userId || userId === actorId) return null;

      const { rows } = await this.pool.query(
        `INSERT INTO notifications (user_id, actor_id, kind, post_id, expires_at)
         VALUES ($1, $2, $3, $4,
                 LEAST(
                   now() + ($5 || ' seconds')::interval,
                   COALESCE((SELECT expires_at FROM posts WHERE id = $4), 'infinity')
                 ))
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, actor_id, kind, post_id, created_at`,
        [userId, actorId, kind, postId, String(NOTIFICATION_TTL_SECONDS)]
      );
      return rows[0] ?? null;
    },

    /**
     * Removes an event that has been undone — an unlike, or an unfollow.
     *
     * Without this, unliking leaves the notification behind, so the bell keeps
     * claiming something that is no longer true and the count never settles.
     * It also restores the ability to notify again later, which is what makes
     * the re-like case honest rather than silently swallowed forever.
     */
    async withdraw({ userId, actorId, kind, postId = null }) {
      if (!userId || userId === actorId) return 0;
      const { rowCount } = await this.pool.query(
        `DELETE FROM notifications
          WHERE user_id = $1 AND actor_id = $2 AND kind = $3
            AND post_id IS NOT DISTINCT FROM $4`,
        [userId, actorId, kind, postId]
      );
      return rowCount;
    },

    /**
     * A page of notifications, newest first, with the actor's username and
     * enough of the post to render a line without a second round trip.
     *
     * Expired rows are excluded rather than relied on being reaped: the reaper
     * runs every 60s, and a notification pointing at a post that is already
     * gone is worse than one arriving a minute late.
     */
    async list(userId, { limit = 30 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT n.id, n.kind, n.created_at, n.read_at, n.post_id,
                a.username AS actor_username,
                p.body     AS post_body
           FROM notifications n
           JOIN users a ON a.id = n.actor_id
           LEFT JOIN posts p ON p.id = n.post_id
                            AND p.removed_at IS NULL
                            AND p.expires_at > now()
          WHERE n.user_id = $1
            AND n.expires_at > now()
            -- A blocked actor's activity is not shown. Blocking is symmetric
            -- everywhere else in the feed; a notification list that still
            -- named them would be a hole in it.
            AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = n.actor_id AND b.blocked_id = $1)
                      OR (b.blocker_id = $1 AND b.blocked_id = n.actor_id))
          ORDER BY n.created_at DESC
          LIMIT $2`,
        [userId, limit]
      );

      return rows.map((r) => ({
        id: String(r.id),
        kind: r.kind,
        createdAt: r.created_at,
        read: r.read_at !== null,
        postId: r.post_id,
        actorUsername: r.actor_username,
        // Null when the post has expired or been removed but the notification
        // has not been reaped yet. The client renders that as unavailable
        // rather than as an empty post.
        postExcerpt: r.post_body ? r.post_body.slice(0, 80) : null,
      }));
    },

    /** The badge. Same block filter as the list, or the two disagree. */
    async unreadCount(userId) {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n
           FROM notifications n
          WHERE n.user_id = $1
            AND n.read_at IS NULL
            AND n.expires_at > now()
            AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = n.actor_id AND b.blocked_id = $1)
                      OR (b.blocker_id = $1 AND b.blocked_id = n.actor_id))`,
        [userId]
      );
      return rows[0].n;
    },

    /** Marks everything read. Idempotent. */
    async markAllRead(userId) {
      const { rowCount } = await this.pool.query(
        `UPDATE notifications SET read_at = now()
          WHERE user_id = $1 AND read_at IS NULL`,
        [userId]
      );
      return rowCount;
    },
  };
}
