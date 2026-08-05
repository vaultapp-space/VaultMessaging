// ============================================================
// Vault — repos/chats.repo.js
// ============================================================
// Conversations as first-class rows: identity, membership, ordering and read
// state.
//
// Two rules from the plan are enforced here rather than left to callers,
// because both are the kind of thing that erodes one convenient query at a
// time:
//
//   1. Chats are durable, messages are not. A chat whose messages have all
//      expired stays in the list, empty. That means the chat-list query must
//      never join through `messages` — see listForUser.
//
//   2. Per-chat TTL can only ever shorten a message's life. The 24h ceiling
//      is applied on the way out of resolveTtlSeconds, not trusted from the
//      client or from the chat row.

// Namespace for deterministic private chat ids. Must match the value in
// migrations/0003_backfill_chats.js — changing it would repartition every
// existing private conversation.
export const CHAT_NAMESPACE = 'b7f4a3c2-8e1d-4f6a-9b2c-5d3e7a1f8c04';

export const MAX_TTL_SECONDS = 24 * 60 * 60;

export function createChats({ pool }) {
  return {
    pool,

    // Deterministic id for a pair, so both participants derive the same chat
    // without a lookup table and without a race over who sends first.
    async privateChatId(userA, userB) {
      const { rows } = await this.pool.query(
        `SELECT uuid_generate_v5($1::uuid, LEAST($2::uuid,$3::uuid)::text || GREATEST($2::uuid,$3::uuid)::text) AS id`,
        [CHAT_NAMESPACE, userA, userB]
      );
      return rows[0].id;
    },

    async get(chatId) {
      const { rows } = await this.pool.query(
        `SELECT c.*,
                COALESCE(
                  json_agg(json_build_object(
                    'id', u.id, 'username', u.username, 'role', cm.role
                  ) ORDER BY u.username) FILTER (WHERE u.id IS NOT NULL),
                  '[]'
                ) AS members
           FROM chats c
           LEFT JOIN chat_members cm ON cm.chat_id = c.id
           LEFT JOIN users u         ON u.id = cm.user_id
          WHERE c.id = $1
          GROUP BY c.id`,
        [chatId]
      );
      return rows[0] ? shapeChat(rows[0]) : null;
    },

    async isMember(chatId, userId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
      return rows.length > 0;
    },

    // Idempotent. Commenting on a channel post joins the discussion group,
    // and doing that twice must not be an error.
    async addMember(chatId, userId, role = 'member') {
      await this.pool.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (chat_id, user_id) DO NOTHING`,
        [chatId, userId, role]
      );
    },

    async memberIds(chatId) {
      const { rows } = await this.pool.query(
        `SELECT user_id FROM chat_members WHERE chat_id = $1`, [chatId]
      );
      return rows.map((r) => r.user_id);
    },

    // Creates the private chat for a pair if it does not exist. Safe to call
    // concurrently from both sides: the id is deterministic and the insert
    // is a no-op on conflict.
    async ensurePrivateChat(userA, userB, { mode = 'cloud' } = {}) {
      const id = await this.privateChatId(userA, userB);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO chats (id, type, mode, members_count)
           VALUES ($1, 'private', $2::chat_mode, 2)
           ON CONFLICT (id) DO NOTHING`,
          [id, mode]
        );
        await client.query(
          `INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3)
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [id, userA, userB]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return id;
    },

    async createGroupChat({ title, createdBy, memberIds, mode = 'cloud' }) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO chats (type, mode, title, created_by, members_count)
           VALUES ('group', $1::chat_mode, $2, $3, $4)
           RETURNING id`,
          [mode, title, createdBy, memberIds.length]
        );
        const chatId = rows[0].id;
        for (const userId of memberIds) {
          await client.query(
            `INSERT INTO chat_members (chat_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (chat_id, user_id) DO NOTHING`,
            [chatId, userId, userId === createdBy ? 'owner' : 'member']
          );
        }
        await client.query('COMMIT');
        return this.get(chatId);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // The chat list.
    //
    // Note what this does NOT do: join through `messages`. An INNER JOIN is
    // the obvious way to fetch a preview, and it would make every quiet chat
    // vanish the moment the reaper runs — messages expire after 24h, chats do
    // not. The preview comes from a LATERAL subquery that is allowed to
    // return nothing, so an empty conversation still appears in the list.
    async listForUser(userId, { includeArchived = false } = {}) {
      const { rows } = await this.pool.query(
        `SELECT c.id,
                c.type,
                c.mode,
                c.title,
                c.username,
                c.last_seq,
                c.last_message_at,
                c.members_count,
                c.created_by,
                COALESCE(r.unread_count, 0)  AS unread_count,
                COALESCE(r.read_inbox_max_seq, 0) AS read_inbox_max_seq,
                s.muted_until,
                COALESCE(s.archived, false)  AS archived,
                s.pinned_order,
                s.theme,
                c.is_forum,
                peer.id       AS peer_id,
                peer.username AS peer_username,
                last_msg.seq        AS last_seq_present,
                last_msg.sent_at    AS last_sent_at,
                last_msg.sender_id  AS last_sender_id
           FROM chat_members me
           JOIN chats c ON c.id = me.chat_id
           LEFT JOIN chat_read_state r
                  ON r.chat_id = c.id AND r.user_id = $1
           LEFT JOIN chat_settings s
                  ON s.chat_id = c.id AND s.user_id = $1
           -- The other participant, for private chats only.
           LEFT JOIN LATERAL (
                SELECT u.id, u.username
                  FROM chat_members other
                  JOIN users u ON u.id = other.user_id
                 WHERE other.chat_id = c.id AND other.user_id <> $1
                 LIMIT 1
           ) peer ON c.type = 'private'
           -- Optional: absent once the last message expires, which is the
           -- whole point — the chat row survives its contents.
           LEFT JOIN LATERAL (
                SELECT m.seq, m.sent_at, m.sender_id
                  FROM messages m
                 WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                 ORDER BY m.sent_at DESC
                 LIMIT 1
           ) last_msg ON true
          WHERE me.user_id = $1
            AND ($2::boolean OR COALESCE(s.archived, false) = false)
          ORDER BY s.pinned_order NULLS LAST, c.last_message_at DESC NULLS LAST`,
        [userId, includeArchived]
      );

      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        mode: row.mode,
        title: row.type === 'private' ? row.peer_username : row.title,
        username: row.username,
        peerId: row.peer_id,
        peerUsername: row.peer_username,
        lastSeq: Number(row.last_seq),
        lastMessageAt: row.last_message_at,
        membersCount: row.members_count,
        createdBy: row.created_by,
        unreadCount: Number(row.unread_count),
        readInboxMaxSeq: Number(row.read_inbox_max_seq),
        mutedUntil: row.muted_until,
        archived: row.archived,
        pinnedOrder: row.pinned_order,
        theme: row.theme ?? null,
        isForum: Boolean(row.is_forum),
        // Null when the conversation has emptied out. Clients must render
        // this as "messages expired", not as a brand-new chat.
        isEmpty: row.last_seq_present === null,
      }));
    },

    // Allocates the next per-chat sequence number. Must run inside the send
    // transaction: the UPDATE ... RETURNING is what serialises concurrent
    // senders without a separate lock.
    async allocateSeq(chatId, client = null) {
      const runner = client || this.pool;
      const { rows } = await runner.query(
        `UPDATE chats SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
        [chatId]
      );
      return rows[0] ? Number(rows[0].last_seq) : null;
    },

    async touchLastMessageAt(chatId, sentAt, client = null) {
      const runner = client || this.pool;
      await runner.query(
        `UPDATE chats SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2)
          WHERE id = $1`,
        [chatId, sentAt]
      );
    },

    // ─── read state ─────────────────────────────────────────

    // Both branches recompute the remainder rather than assuming a full read.
    // The insert path matters as much as the conflict path: the first time a
    // user reads a chat there is no row yet, and hardcoding zero there would
    // clear the badge for messages they have not actually seen.
    async readHistory(chatId, userId, maxSeq) {
      const { rows } = await this.pool.query(
        `INSERT INTO chat_read_state (chat_id, user_id, read_inbox_max_seq, unread_count)
         SELECT $1, $2, $3,
                (SELECT count(*) FROM messages m
                  WHERE m.chat_id = $1
                    AND m.sender_id <> $2
                    AND m.deleted_at IS NULL
                    AND m.seq > $3)
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET read_inbox_max_seq = GREATEST(chat_read_state.read_inbox_max_seq, EXCLUDED.read_inbox_max_seq),
                unread_count = (
                  SELECT count(*) FROM messages m
                   WHERE m.chat_id = $1
                     AND m.sender_id <> $2
                     AND m.deleted_at IS NULL
                     AND m.seq > GREATEST(chat_read_state.read_inbox_max_seq, EXCLUDED.read_inbox_max_seq)
                )
         RETURNING read_inbox_max_seq, unread_count`,
        [chatId, userId, maxSeq]
      );
      return rows[0];
    },

    async incrementUnread(chatId, senderId, client = null) {
      const runner = client || this.pool;
      await runner.query(
        `INSERT INTO chat_read_state (chat_id, user_id, unread_count)
         SELECT $1, cm.user_id, 1
           FROM chat_members cm
          WHERE cm.chat_id = $1 AND cm.user_id <> $2
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET unread_count = chat_read_state.unread_count + 1`,
        [chatId, senderId]
      );
    },

    // Recomputes unread counts from what actually remains. Called after the
    // reaper runs: a chat must never sit at "3 unread" with nothing to show.
    async reconcileUnread(chatIds = null) {
      const { rowCount } = await this.pool.query(
        `UPDATE chat_read_state r
            SET unread_count = COALESCE(sub.n, 0)
           FROM (
                SELECT cm.chat_id, cm.user_id,
                       count(m.id) FILTER (
                         WHERE m.sender_id <> cm.user_id
                           AND m.deleted_at IS NULL
                           AND m.seq > COALESCE(rs.read_inbox_max_seq, 0)
                       ) AS n
                  FROM chat_members cm
                  LEFT JOIN chat_read_state rs
                         ON rs.chat_id = cm.chat_id AND rs.user_id = cm.user_id
                  LEFT JOIN messages m ON m.chat_id = cm.chat_id
                 WHERE ($1::uuid[] IS NULL OR cm.chat_id = ANY($1))
                 GROUP BY cm.chat_id, cm.user_id
           ) sub
          WHERE r.chat_id = sub.chat_id
            AND r.user_id = sub.user_id
            AND r.unread_count <> COALESCE(sub.n, 0)`,
        [chatIds]
      );
      return rowCount;
    },

    // ─── ttl ────────────────────────────────────────────────

    // The single place a message's lifetime is decided. Whatever the chat or
    // the client asks for, the result is clamped to the 24h ceiling.
    resolveTtlSeconds({ requestedSeconds = null, chatDefaultSeconds = null } = {}) {
      const candidates = [requestedSeconds, chatDefaultSeconds, MAX_TTL_SECONDS]
        .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      return Math.min(...candidates, MAX_TTL_SECONDS);
    },
  };
}

function shapeChat(row) {
  return {
    id: row.id,
    type: row.type,
    mode: row.mode,
    title: row.title,
    username: row.username,
    createdBy: row.created_by,
    lastSeq: Number(row.last_seq),
    lastMessageAt: row.last_message_at,
    membersCount: row.members_count,
    defaultTtlSecs: row.default_ttl_secs,
    isForum: Boolean(row.is_forum),
    isBroadcast: Boolean(row.is_broadcast),
    linkedChatId: row.linked_chat_id ?? null,
    members: row.members || [],
  };
}
