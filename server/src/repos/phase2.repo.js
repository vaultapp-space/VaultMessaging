// ============================================================
// Vault — repos/phase2.repo.js
// ============================================================
// Deletion, pins, forwarding, drafts, chat settings, blocking and search.
//
// Grouped in one module because they share a single concern — they all
// operate on an existing chat or message rather than creating new ones — and
// splitting them into six near-empty files would obscure that. Each section
// below is independent; split them out if any grows a real surface.
//
// Everything here inherits the 24-hour rule. Nothing added grants a longer
// life to anything: a tombstone dies with its message, a draft dies with its
// chat, and search only ever sees what has not yet been reaped.

export function createPhase2({ pool }) {
  return {
    pool,

    // ─── Deletion ─────────────────────────────────────────
    //
    // Two different operations that users think of as one word.

    // Visible to everyone. The row is kept and tombstoned rather than removed
    // so the deletion can be broadcast and each client can replace the text
    // in place — a hard DELETE would leave a silent hole that looks like a
    // sync bug. The reaper removes it for real at expiry.
    async deleteForEveryone(chatId, seq, userId) {
      const res = await this.pool.query(
        `UPDATE messages
            SET deleted_at = now(), body = NULL, entities = NULL, media = NULL
          WHERE chat_id = $1 AND seq = $2 AND sender_id = $3 AND deleted_at IS NULL
          RETURNING id, chat_id, seq, deleted_at`,
        [chatId, seq, userId]
      );
      return res.rows[0] || null;
    },

    // Visible only to the caller. Nobody else's transcript changes, which is
    // the whole distinction from the above.
    async deleteForMe(chatId, seq, userId) {
      await this.pool.query(
        `INSERT INTO message_deleted_for (chat_id, seq, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (chat_id, seq, user_id) DO NOTHING`,
        [chatId, seq, userId]
      );
      return { chatId, seq, userId };
    },

    async hiddenSeqsFor(chatId, userId) {
      const res = await this.pool.query(
        `SELECT seq FROM message_deleted_for WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
      return res.rows.map((r) => Number(r.seq));
    },

    // ─── Pins ─────────────────────────────────────────────

    async pin(chatId, seq, userId) {
      const res = await this.pool.query(
        `UPDATE messages SET pinned_at = now(), pinned_by = $3
          WHERE chat_id = $1 AND seq = $2 AND deleted_at IS NULL
          RETURNING id, chat_id, seq, pinned_at, pinned_by`,
        [chatId, seq, userId]
      );
      return res.rows[0] || null;
    },

    async unpin(chatId, seq) {
      const res = await this.pool.query(
        `UPDATE messages SET pinned_at = NULL, pinned_by = NULL
          WHERE chat_id = $1 AND seq = $2
          RETURNING id, chat_id, seq`,
        [chatId, seq]
      );
      return res.rows[0] || null;
    },

    async listPinned(chatId) {
      const res = await this.pool.query(
        `SELECT seq, body, sender_id, pinned_at, pinned_by
           FROM messages
          WHERE chat_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
          ORDER BY pinned_at DESC`,
        [chatId]
      );
      return res.rows.map((r) => ({
        seq: Number(r.seq),
        body: r.body,
        senderId: r.sender_id,
        pinnedAt: r.pinned_at,
        pinnedBy: r.pinned_by,
      }));
    },

    // ─── Drafts ───────────────────────────────────────────
    //
    // Cloud chats only. A draft is plaintext by nature; storing one for an
    // end-to-end encrypted conversation would hand the server exactly the
    // content that conversation exists to keep from it.

    async saveDraft(chatId, userId, { body, entities = null, replyToSeq = null }) {
      const res = await this.pool.query(
        `INSERT INTO drafts (chat_id, user_id, body, entities, reply_to_seq, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET body = EXCLUDED.body,
                entities = EXCLUDED.entities,
                reply_to_seq = EXCLUDED.reply_to_seq,
                updated_at = now()
         RETURNING chat_id, body, entities, reply_to_seq, updated_at`,
        [chatId, userId, body, entities ? JSON.stringify(entities) : null, replyToSeq]
      );
      return res.rows[0];
    },

    async clearDraft(chatId, userId) {
      await this.pool.query(
        `DELETE FROM drafts WHERE chat_id = $1 AND user_id = $2`, [chatId, userId]
      );
    },

    async listDrafts(userId) {
      const res = await this.pool.query(
        `SELECT chat_id, body, entities, reply_to_seq, updated_at
           FROM drafts WHERE user_id = $1`,
        [userId]
      );
      return res.rows.map((r) => ({
        chatId: r.chat_id,
        body: r.body,
        entities: r.entities,
        replyToSeq: r.reply_to_seq === null ? null : Number(r.reply_to_seq),
        updatedAt: r.updated_at,
      }));
    },

    // ─── Chat settings ────────────────────────────────────

    async updateChatSettings(chatId, userId, patch) {
      const res = await this.pool.query(
        `INSERT INTO chat_settings (chat_id, user_id, muted_until, archived, pinned_order, ttl_secs, theme)
         VALUES ($1, $2, $3, COALESCE($4, false), $5, $6, $7)
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET muted_until  = COALESCE($3, chat_settings.muted_until),
                archived     = COALESCE($4, chat_settings.archived),
                pinned_order = COALESCE($5, chat_settings.pinned_order),
                ttl_secs     = COALESCE($6, chat_settings.ttl_secs),
                -- '' means "back to the default"; NULL still means "leave
                -- alone", the same convention as every other column here.
                theme        = CASE WHEN $7 = '' THEN NULL
                                    ELSE COALESCE($7, chat_settings.theme) END
         RETURNING chat_id, muted_until, archived, pinned_order, ttl_secs, theme`,
        [
          chatId, userId,
          patch.mutedUntil ?? null,
          patch.archived ?? null,
          patch.pinnedOrder ?? null,
          patch.ttlSecs ?? null,
          patch.theme ?? null,
        ]
      );
      const row = res.rows[0];
      return {
        chatId: row.chat_id,
        mutedUntil: row.muted_until,
        archived: row.archived,
        pinnedOrder: row.pinned_order,
        ttlSecs: row.ttl_secs,
        theme: row.theme,
      };
    },

    // Explicit clears, because COALESCE above deliberately treats null as
    // "leave alone" — there has to be a way to actually unset these.
    async unmute(chatId, userId) {
      await this.pool.query(
        `UPDATE chat_settings SET muted_until = NULL WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
    },

    async unpinChat(chatId, userId) {
      await this.pool.query(
        `UPDATE chat_settings SET pinned_order = NULL WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
      );
    },

    // ─── Blocking ─────────────────────────────────────────

    async block(blockerId, blockedId) {
      await this.pool.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [blockerId, blockedId]
      );
    },

    async unblock(blockerId, blockedId) {
      await this.pool.query(
        `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [blockerId, blockedId]
      );
    },

    // True if either party has blocked the other. Blocking is symmetric in
    // effect: the blocker should not receive from the blocked, and the
    // blocked should not be able to reach the blocker.
    async isBlockedBetween(a, b) {
      const res = await this.pool.query(
        `SELECT 1 FROM blocks
          WHERE (blocker_id = $1 AND blocked_id = $2)
             OR (blocker_id = $2 AND blocked_id = $1)
          LIMIT 1`,
        [a, b]
      );
      return res.rows.length > 0;
    },

    async listBlocked(userId) {
      const res = await this.pool.query(
        `SELECT u.id, u.username FROM blocks b
           JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1
          ORDER BY u.username`,
        [userId]
      );
      return res.rows;
    },

    // ─── Presence ─────────────────────────────────────────

    async touchLastSeen(userId) {
      await this.pool.query(
        `UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]
      );
    },

    async getPresence(userIds) {
      if (!userIds.length) return [];
      const res = await this.pool.query(
        `SELECT id, last_seen_at, presence_privacy FROM users WHERE id = ANY($1)`,
        [userIds]
      );
      return res.rows.map((r) => ({
        userId: r.id,
        lastSeenAt: r.presence_privacy === 'nobody' ? null : r.last_seen_at,
        privacy: r.presence_privacy,
      }));
    },

    // ─── Search ───────────────────────────────────────────

    // Scoped to the caller's own memberships, always. An unscoped variant of
    // this query is a full-database content leak, so the membership subquery
    // is part of the statement rather than something a caller can forget.
    //
    // Only cloud chats can match: `search_tsv` is generated from `body`, and
    // secret messages never populate one. That is a structural exclusion, not
    // a filter — there is no way to accidentally search encrypted content.
    async searchMessages(userId, query, { limit = 50 } = {}) {
      const res = await this.pool.query(
        `SELECT m.chat_id, m.seq, m.body, m.sender_id, m.sent_at,
                c.type AS chat_type, c.title AS chat_title,
                u.username AS sender_username,
                ts_rank(m.search_tsv, websearch_to_tsquery('simple', $2)) AS rank
           FROM messages m
           JOIN chats c ON c.id = m.chat_id
           LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = $1)
            AND m.deleted_at IS NULL
            AND m.body IS NOT NULL
            AND m.search_tsv @@ websearch_to_tsquery('simple', $2)
            AND NOT EXISTS (
                  SELECT 1 FROM message_deleted_for d
                   WHERE d.chat_id = m.chat_id AND d.seq = m.seq AND d.user_id = $1
            )
          ORDER BY rank DESC, m.sent_at DESC
          LIMIT $3`,
        [userId, query, limit]
      );

      return res.rows.map((r) => ({
        chatId: r.chat_id,
        seq: Number(r.seq),
        body: r.body,
        senderId: r.sender_id,
        senderUsername: r.sender_username,
        sentAt: r.sent_at,
        chatType: r.chat_type,
        chatTitle: r.chat_title,
      }));
    },

    // ─── Link previews ────────────────────────────────────
    //
    // Cached by URL hash so a link shared repeatedly is fetched once. Failures
    // are cached too, with a shorter life, so a dead URL is not re-fetched on
    // every send — otherwise one bad link in a busy chat becomes a steady
    // outbound request stream.

    async getCachedPreview(url, { maxAgeSeconds = 86400 } = {}) {
      const res = await this.pool.query(
        `SELECT url, site_name, title, description, image_url, error, fetched_at
           FROM link_previews
          WHERE url_hash = digest($1, 'sha256')
            AND fetched_at > now() - ($2 || ' seconds')::interval`,
        [url, String(maxAgeSeconds)]
      );
      if (res.rows.length === 0) return null;

      const row = res.rows[0];
      if (row.error) return { failed: true };

      return {
        url: row.url,
        siteName: row.site_name,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
      };
    },

    async cachePreview(url, preview) {
      await this.pool.query(
        `INSERT INTO link_previews (url_hash, url, site_name, title, description, image_url, error, fetched_at)
         VALUES (digest($1, 'sha256'), $1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (url_hash) DO UPDATE
            SET site_name = EXCLUDED.site_name,
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                image_url = EXCLUDED.image_url,
                error = EXCLUDED.error,
                fetched_at = now()`,
        [
          url,
          preview?.siteName ?? null,
          preview?.title ?? null,
          preview?.description ?? null,
          preview?.imageUrl ?? null,
          preview ? null : 'unfurl failed',
        ]
      );
    },

    async attachPreview(chatId, seq, preview) {
      await this.pool.query(
        `UPDATE messages SET preview = $3 WHERE chat_id = $1 AND seq = $2`,
        [chatId, seq, JSON.stringify(preview)]
      );
    },
  };
}
