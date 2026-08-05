// ============================================================
// Vault — repos/channels.repo.js
// ============================================================
// Channels: broadcast chats with subscribers instead of members.
//
// The design constraint that shapes everything here is that a channel's
// audience can be orders of magnitude larger than any group's. Two rules
// follow, and breaking either is how a messenger falls over:
//
//   1. **A post writes O(1) rows.** One `messages` row, one `chats` update.
//      It does not write a `user_updates` row per subscriber — for a channel
//      with a million subscribers that is a million inserts for one post.
//      Offline subscribers discover the post from `chats.last_message_at`
//      and pull it when they open the channel.
//
//   2. **Views are counted in Redis, not SQL.** A per-view UPDATE on a hot
//      post is a write-contention hotspot on a single row; the counter is
//      accumulated in a Redis set and flushed periodically.
//
// Admins live in `chat_members` (a handful of rows, and they need the whole
// rights model from Phase 3). Subscribers live in `channel_subscribers`,
// which is partitioned. Keeping them apart is what stops the subscriber
// count from slowing down every membership check in the product.

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{5,32}$/;

export function createChannels({ pool, redis = null }) {
  return {
    pool,
    redis,

    // ─── Creation ─────────────────────────────────────────

    /**
     * Creates a channel.
     *
     * Always cloud mode, and not by omission: a broadcast chat cannot be
     * end-to-end encrypted in any meaningful sense. Sender keys assume a
     * membership small enough to rekey when someone leaves, and a channel
     * anyone can join and leave would be rekeying constantly while still
     * handing the key to every subscriber. Claiming E2EE here would be a lie
     * with a nice padlock on it.
     */
    async create(creatorId, { title, about = null, username = null }) {
      if (username !== null && !USERNAME_PATTERN.test(username)) {
        return { ok: false, reason: 'invalid username' };
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `INSERT INTO chats (type, mode, title, about, username, created_by,
                              is_broadcast, members_count)
           VALUES ('channel', 'cloud', $1, $2, $3, $4, true, 1)
           RETURNING id, type, mode, title, about, username, created_by,
                     is_broadcast, signatures_enabled, last_seq, last_message_at`,
          [title, about, username, creatorId]
        );
        const channel = rows[0];

        // The creator is an admin, not a subscriber: they post, and the two
        // roles are stored in different tables on purpose.
        await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [channel.id, creatorId]
        );

        await client.query('COMMIT');
        return { ok: true, channel: this.shape(channel) };
      } catch (err) {
        await client.query('ROLLBACK');
        // A taken username is a user-facing outcome, not a server error.
        if (err.code === '23505') return { ok: false, reason: 'username taken' };
        throw err;
      } finally {
        client.release();
      }
    },

    shape(row) {
      if (!row) return null;
      return {
        id: row.id,
        type: row.type,
        mode: row.mode,
        title: row.title,
        about: row.about,
        username: row.username,
        createdBy: row.created_by,
        isBroadcast: row.is_broadcast,
        signaturesEnabled: row.signatures_enabled,
        linkedChatId: row.linked_chat_id ?? null,
        lastSeq: row.last_seq === undefined ? undefined : Number(row.last_seq),
        lastMessageAt: row.last_message_at,
        subscribersCount: row.subscribers_count === undefined
          ? undefined
          : Number(row.subscribers_count),
      };
    },

    async get(chatId) {
      const { rows } = await this.pool.query(
        `SELECT c.*, (SELECT count(*) FROM channel_subscribers s WHERE s.chat_id = c.id)
                     AS subscribers_count
           FROM chats c WHERE c.id = $1 AND c.type = 'channel'`,
        [chatId]
      );
      return this.shape(rows[0]);
    },

    async getByUsername(username) {
      const { rows } = await this.pool.query(
        `SELECT c.*, (SELECT count(*) FROM channel_subscribers s WHERE s.chat_id = c.id)
                     AS subscribers_count
           FROM chats c WHERE lower(c.username) = lower($1) AND c.type = 'channel'`,
        [username]
      );
      return this.shape(rows[0]);
    },

    // ─── Subscription ─────────────────────────────────────

    async subscribe(chatId, userId) {
      await this.pool.query(
        `INSERT INTO channel_subscribers (chat_id, user_id) VALUES ($1, $2)
         ON CONFLICT (chat_id, user_id) DO NOTHING`,
        [chatId, userId]
      );
    },

    async unsubscribe(chatId, userId) {
      await this.pool.query(
        `DELETE FROM channel_subscribers WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
    },

    async isSubscribed(chatId, userId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM channel_subscribers WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
      return rows.length > 0;
    },

    /** Admins are members; everyone else who can read is a subscriber. */
    async canRead(chatId, userId) {
      const { rows } = await this.pool.query(
        `SELECT
           EXISTS (SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2) AS is_admin,
           EXISTS (SELECT 1 FROM channel_subscribers WHERE chat_id = $1 AND user_id = $2) AS is_sub,
           (SELECT username IS NOT NULL FROM chats WHERE id = $1) AS is_public`,
        [chatId, userId]
      );
      if (rows.length === 0) return false;
      const r = rows[0];
      // A public channel is readable by anyone — that is what public means.
      return r.is_admin || r.is_sub || r.is_public;
    },

    async subscriberCount(chatId) {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM channel_subscribers WHERE chat_id = $1`,
        [chatId]
      );
      return rows[0].n;
    },

    /**
     * Subscribers to notify, in pages.
     *
     * Paged rather than returned whole because the caller iterates to send
     * push, and materialising a million ids in one array to do it is how a
     * single post takes the process down.
     */
    async subscriberPage(chatId, { after = null, limit = 1000 } = {}) {
      const params = [chatId, limit];
      let cursor = '';
      if (after) {
        params.push(after);
        cursor = ' AND user_id > $3';
      }
      const { rows } = await this.pool.query(
        `SELECT user_id FROM channel_subscribers
          WHERE chat_id = $1 AND is_muted = false${cursor}
          ORDER BY user_id
          LIMIT $2`,
        params
      );
      return rows.map((r) => r.user_id);
    },

    /** Channels this user subscribes to, for the chat list. */
    async listForUser(userId) {
      const { rows } = await this.pool.query(
        `SELECT c.*, (SELECT count(*) FROM channel_subscribers s2 WHERE s2.chat_id = c.id)
                     AS subscribers_count
           FROM channel_subscribers s
           JOIN chats c ON c.id = s.chat_id
          WHERE s.user_id = $1
          ORDER BY c.last_message_at DESC NULLS LAST`,
        [userId]
      );
      return rows.map((r) => this.shape(r));
    },

    // ─── Views ────────────────────────────────────────────

    /**
     * Records a view.
     *
     * Counted in Redis, not with an UPDATE. A popular post is read by many
     * people at once, and every one of them incrementing the same row turns
     * that row into a lock queue. The set also deduplicates, so a reader
     * refreshing does not inflate the count.
     *
     * The key gets a TTL slightly past the retention window so it expires
     * alongside the post it counts, rather than accumulating forever.
     */
    async recordView(chatId, seq, userId) {
      if (!this.redis) return;
      const key = `views:${chatId}:${seq}`;
      await this.redis.sadd(key, userId);
      await this.redis.expire(key, 90000);
    },

    async viewCount(chatId, seq) {
      if (!this.redis) return 0;
      return this.redis.scard(`views:${chatId}:${seq}`);
    },

    /** Folds the Redis counters into `messages.views`. */
    async flushViews(chatId, seqs) {
      if (!this.redis || seqs.length === 0) return;
      for (const seq of seqs) {
        const count = await this.redis.scard(`views:${chatId}:${seq}`);
        if (count > 0) {
          await this.pool.query(
            // GREATEST, not assignment: the Redis key can expire before the
            // message does, and a stale zero must not erase a real count.
            `UPDATE messages SET views = GREATEST(views, $3)
              WHERE chat_id = $1 AND seq = $2`,
            [chatId, seq, count]
          );
        }
      }
    },

    // ─── Threads (comments) ───────────────────────────────

    /**
     * Records a comment on a channel post.
     *
     * The comment itself is an ordinary message in the linked discussion
     * group; this only maintains the counter the feed renders.
     */
    async addThreadReply(chatId, rootSeq, replySeq) {
      const { rows } = await this.pool.query(
        `INSERT INTO message_threads (chat_id, root_seq, replies_count, last_seq)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (chat_id, root_seq) DO UPDATE
            SET replies_count = message_threads.replies_count + 1,
                last_seq = $3,
                updated_at = now()
         RETURNING replies_count, last_seq`,
        [chatId, rootSeq, replySeq]
      );
      return { repliesCount: rows[0].replies_count, lastSeq: Number(rows[0].last_seq) };
    },

    async threadsFor(chatId, seqs) {
      if (seqs.length === 0) return new Map();
      const { rows } = await this.pool.query(
        `SELECT root_seq, replies_count FROM message_threads
          WHERE chat_id = $1 AND root_seq = ANY($2::bigint[])`,
        [chatId, seqs]
      );
      return new Map(rows.map((r) => [Number(r.root_seq), r.replies_count]));
    },

    /** Links a discussion group to a channel, so posts can take comments. */
    async linkDiscussion(channelId, groupId) {
      await this.pool.query(
        `UPDATE chats SET linked_chat_id = $2 WHERE id = $1`,
        [channelId, groupId]
      );
      await this.pool.query(
        `UPDATE chats SET linked_chat_id = $1 WHERE id = $2`,
        [channelId, groupId]
      );
    },

    // ─── Admin log ────────────────────────────────────────

    /**
     * Records an administrative action.
     *
     * `details` must never carry message content. The log is deliberately
     * exempt from the 24h rule — an audit trail that erased itself daily
     * would not be one — so anything stashed here outlives the retention
     * ceiling, which for message bodies would defeat the whole design.
     */
    async logAction(chatId, actorId, action, { targetId = null, details = null } = {}) {
      await this.pool.query(
        `INSERT INTO chat_admin_log (chat_id, actor_id, action, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [chatId, actorId, action, targetId, details ? JSON.stringify(details) : null]
      );
    },

    async adminLog(chatId, { limit = 100 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT l.id, l.action, l.created_at, l.details,
                actor.username AS actor_username,
                target.username AS target_username
           FROM chat_admin_log l
           LEFT JOIN users actor  ON actor.id  = l.actor_id
           LEFT JOIN users target ON target.id = l.target_id
          WHERE l.chat_id = $1
          ORDER BY l.created_at DESC
          LIMIT $2`,
        [chatId, limit]
      );
      return rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        createdAt: r.created_at,
        actor: r.actor_username,
        target: r.target_username,
        details: r.details,
      }));
    },

    // ─── Settings ─────────────────────────────────────────

    async setSignatures(chatId, enabled) {
      await this.pool.query(
        `UPDATE chats SET signatures_enabled = $2 WHERE id = $1`,
        [chatId, Boolean(enabled)]
      );
    },

    /** Public directory search. Only ever returns channels with a username. */
    async search(query, { limit = 20 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT c.*, (SELECT count(*) FROM channel_subscribers s WHERE s.chat_id = c.id)
                     AS subscribers_count
           FROM chats c
          WHERE c.type = 'channel'
            AND c.username IS NOT NULL
            AND (c.username ILIKE $1 OR c.title ILIKE $1)
          ORDER BY subscribers_count DESC
          LIMIT $2`,
        [`%${query}%`, limit]
      );
      return rows.map((r) => this.shape(r));
    },
  };
}
