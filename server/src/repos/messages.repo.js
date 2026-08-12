// ============================================================
// Vault — repos/messages.repo.js
// ============================================================
// Message rows. For secret chats these are ciphertext blobs and the server
// never sees plaintext; cloud chats additionally populate body/entities/media.
// Either way `expires_at` is NOT NULL and the reaper deletes the row 24 hours
// after it was sent — there is no unlimited-retention path.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.




// `messages.type` is a smallint so the column stays narrow. These two keep the
// mapping in one place; the names match shared/envelope.js MessageType.
const TYPE_CODES = ['text', 'photo', 'video', 'voice', 'audio', 'document',
                    'sticker', 'poll', 'location', 'contact', 'service', 'op'];

function messageTypeToSmallint(type) {
  const idx = TYPE_CODES.indexOf(type);
  return idx === -1 ? 0 : idx;
}

function smallintToMessageType(code) {
  return TYPE_CODES[code] ?? 'text';
}

export function createMessages({ pool }) {
  return {
    pool,

  // Secret-chat send. The ciphertext is opaque, but the message still gets a
  // per-chat `seq` when the sender names a chat.
  //
  // That matters beyond bookkeeping: seq is how a message is *addressed*.
  // Reactions, replies, pins and edits all reference (chat_id, seq), so
  // without one a secret message cannot be reacted to or replied to at all —
  // the affordance simply never appears. Allocating it here is what lets the
  // Phase 2 features work identically in both modes.
  async createMessage({ senderId, recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, expiresAt, iv, groupId = null, attachmentId = null, chatId = null }) {
    let seq = null;
    if (chatId) {
      const seqRes = await this.pool.query(
        `UPDATE chats SET last_seq = last_seq + 1, last_message_at = now()
          WHERE id = $1 RETURNING last_seq`,
        [chatId]
      );
      seq = seqRes.rows[0] ? Number(seqRes.rows[0].last_seq) : null;
    }

    const res = await this.pool.query(
      `INSERT INTO messages (sender_id, recipient_id, ciphertext, ephemeral_key, message_number, previous_chain, expires_at, iv, group_id, attachment_id, chat_id, seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, sender_id, recipient_id, ciphertext, ephemeral_key, message_number, previous_chain, expires_at, sent_at, iv, group_id, attachment_id, chat_id, seq`,
      [senderId, recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, expiresAt, iv, groupId, attachmentId, chatId, seq]
    );

    const msg = res.rows[0];

    // Attachment authorisation used to happen here, via
    // `this.authorizeAttachmentUser` — which lives on the attachments repo,
    // not this one, so `this` never had it and every secret message carrying
    // a file threw "not a function" and 500'd. It is done in the route now,
    // where both repos are in scope, the same way the cloud path does it.

    return msg;
  },

  async markDelivered(messageId) {
    await this.pool.query(
      `UPDATE messages SET delivered = TRUE WHERE id = $1`,
      [messageId]
    );
  },

  async markRead(messageId) {
    await this.pool.query(
      `UPDATE messages SET read = TRUE WHERE id = $1`,
      [messageId]
    );
  },

  async getMessage(id) {
    const res = await this.pool.query(
      `SELECT * FROM messages WHERE id = $1`,
      [id]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  },

  async getUndeliveredMessages(recipientId) {
    const res = await this.pool.query(
      `SELECT m.*, u.username as sender_username FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.recipient_id = $1 AND m.delivered = FALSE
       ORDER BY m.sent_at ASC`,
      [recipientId]
    );
    return res.rows.map(row => ({
      id: row.id,
      sender_id: row.sender_id,
      sender_username: row.sender_username,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      ephemeral_key: row.ephemeral_key,
      message_number: row.message_number,
      previous_chain: row.previous_chain,
      sent_at: row.sent_at,
      expires_at: row.expires_at,
      iv: row.iv,
      group_id: row.group_id,
      attachment_id: row.attachment_id,
      read: row.read
    }));
  },

  async getConversationMessages(userId1, userId2, limit = 50, before = null) {
    let query = `
      SELECT m.*, u.username as sender_username FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE (
        (m.sender_id = $1 AND m.recipient_id = $2) OR
        (m.sender_id = $2 AND m.recipient_id = $1)
      )
    `;
    const params = [userId1, userId2, limit];
    if (before) {
      query += ` AND m.sent_at < $4`;
      params.push(before);
    }
    query += ` ORDER BY m.sent_at DESC LIMIT $3`;
    const res = await this.pool.query(query, params);
    return res.rows.map(row => ({
      id: row.id,
      sender_id: row.sender_id,
      sender_username: row.sender_username,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      ephemeral_key: row.ephemeral_key,
      message_number: row.message_number,
      previous_chain: row.previous_chain,
      sent_at: row.sent_at,
      expires_at: row.expires_at,
      iv: row.iv,
      group_id: row.group_id,
      attachment_id: row.attachment_id,
      read: row.read
    }));
  },

  async getConversationsForUser(userId) {
    const res = await this.pool.query(
      `SELECT DISTINCT ON (peer_id)
         peer_id,
         username as peer_username,
         last_message_at
       FROM (
         SELECT recipient_id as peer_id, sent_at as last_message_at FROM messages WHERE sender_id = $1
         UNION ALL
         SELECT sender_id as peer_id, sent_at as last_message_at FROM messages WHERE recipient_id = $1
       ) t
       JOIN users u ON t.peer_id = u.id
       ORDER BY peer_id, last_message_at DESC`,
      [userId]
    );

    const undeliveredRes = await this.pool.query(
      `SELECT DISTINCT sender_id FROM messages WHERE recipient_id = $1 AND delivered = FALSE`,
      [userId]
    );
    const peersWithUndelivered = new Set(undeliveredRes.rows.map(r => r.sender_id));

    return res.rows.map(row => ({
      peerId: row.peer_id,
      peerUsername: row.peer_username,
      lastMessageAt: row.last_message_at,
      hasUndelivered: peersWithUndelivered.has(row.peer_id)
    }));
  },

  // ─── Cloud chats ────────────────────────────────────────
  // Plaintext storage. `expires_at` is computed from the clamped TTL the
  // caller resolved, so a cloud message expires exactly like a secret one.
  async createCloudMessage({
    chatId, senderId, type = 'text', body = null, entities = null, media = null,
    replyToSeq = null, groupedId = null, ttlSeconds, clientRandomId = null,
    viewOnce = false, threadRootSeq = null, topicId = null,
    fwdFromChat = null, fwdFromSeq = null,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // A retried send must resolve to the original message rather than a
      // duplicate. Checked inside the transaction so two in-flight retries
      // cannot both pass.
      if (clientRandomId !== null && clientRandomId !== undefined) {
        const existing = await client.query(
          `SELECT id, seq, sent_at, expires_at FROM messages
            WHERE sender_id = $1 AND client_random_id = $2`,
          [senderId, clientRandomId]
        );
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          return existing.rows[0];
        }
      }

      const seqRes = await client.query(
        `UPDATE chats SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
        [chatId]
      );
      if (seqRes.rows.length === 0) {
        throw new Error('Chat not found');
      }
      const seq = seqRes.rows[0].last_seq;

      const res = await client.query(
        `INSERT INTO messages
           (chat_id, seq, sender_id, ciphertext, type, body, entities, media,
            reply_to_seq, grouped_id, client_random_id, view_once, expires_at, sent_at,
            fwd_from_chat, fwd_from_seq, thread_root_seq, topic_id)
         VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8, $9, $10, $11,
                 now() + ($12 || ' seconds')::interval, now(), $13, $14, $15, $16)
         RETURNING id, seq, sent_at, expires_at`,
        [
          chatId, seq, senderId, messageTypeToSmallint(type), body,
          entities ? JSON.stringify(entities) : null,
          media ? JSON.stringify(media) : null,
          replyToSeq, groupedId, clientRandomId, viewOnce, String(ttlSeconds),
          fwdFromChat, fwdFromSeq, threadRootSeq, topicId,
        ]
      );

      await client.query(
        `UPDATE chats SET last_message_at = now() WHERE id = $1`, [chatId]
      );
      await client.query(
        `INSERT INTO chat_read_state (chat_id, user_id, unread_count)
         SELECT $1, cm.user_id, 1 FROM chat_members cm
          WHERE cm.chat_id = $1 AND cm.user_id <> $2
         ON CONFLICT (chat_id, user_id) DO UPDATE
            SET unread_count = chat_read_state.unread_count + 1`,
        [chatId, senderId]
      );

      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Newest first, so the client can render immediately and page backwards.
  // Expired rows are already gone — the reaper deletes them — so no time
  // filter is needed here.
  // `topicId` narrows a forum group to one topic. Undefined means "the whole
  // chat"; passing it explicitly is what makes a forum's topics separate
  // conversations rather than one interleaved stream.
  async getChatMessages(
    chatId,
    { limit = 50, before = null, topicId = null, clearedAt = null } = {}
  ) {
    const params = [chatId, limit];
    let cursor = '';
    if (before) {
      params.push(before);
      cursor = ` AND m.seq < $${params.length}`;
    }
    if (topicId !== null && topicId !== undefined) {
      params.push(topicId);
      cursor += ` AND m.topic_id = $${params.length}`;
    }
    // The caller's own clear point (chat_settings.cleared_at). Applied here
    // rather than after the fact so it cannot be forgotten by one of the
    // history callers, and so a cleared page is not returned short — the
    // LIMIT is applied to rows this viewer may actually see.
    if (clearedAt) {
      params.push(clearedAt);
      cursor += ` AND m.sent_at > $${params.length}`;
    }

    const res = await this.pool.query(
      `SELECT m.id, m.chat_id, m.seq, m.sender_id, u.username AS sender_username,
              m.type, m.body, m.entities, m.media, m.reply_to_seq, m.grouped_id,
              m.edited_at, m.deleted_at, m.pinned_at, m.sent_at, m.expires_at, m.reactions,
              m.fwd_from_chat, m.fwd_from_seq, m.preview, m.view_once, m.post_author, m.topic_id,
              m.ciphertext, m.ephemeral_key, m.iv, m.message_number, m.previous_chain,
              c.mode
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = $1 AND m.deleted_at IS NULL${cursor}
        ORDER BY m.seq DESC
        LIMIT $2`,
      params
    );

    return res.rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      seq: Number(row.seq),
      senderId: row.sender_id,
      senderUsername: row.sender_username,
      mode: row.mode,
      messageType: smallintToMessageType(row.type),
      body: row.body,
      entities: row.entities,
      media: row.media,
      replyToSeq: row.reply_to_seq === null ? null : Number(row.reply_to_seq),
      groupedId: row.grouped_id,
      viewOnce: row.view_once,
      topicId: row.topic_id === null ? null : Number(row.topic_id),
      postAuthor: row.post_author ?? null,
      editedAt: row.edited_at,
      pinnedAt: row.pinned_at,
      forwarded: Boolean(row.fwd_from_chat),
      preview: row.preview ?? null,
      reactions: row.reactions ?? [],
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      // Present only for secret chats; the server cannot read these.
      ciphertext: row.ciphertext || null,
      ephemeralKey: row.ephemeral_key,
      iv: row.iv,
      messageNumber: row.message_number,
      previousChain: row.previous_chain,
    })).reverse();
  },

  // A channel post is attributed to the channel unless the channel signs its
  // posts. The author is recorded either way so the admin log can answer who
  // wrote it without the feed showing it.
  async setPostAuthor(chatId, seq, author) {
    await this.pool.query(
      `UPDATE messages SET post_author = $3 WHERE chat_id = $1 AND seq = $2`,
      [chatId, seq, author]
    );
  },

  // Comments on a channel post: ordinary messages in the linked discussion
  // group, tagged with the post they hang off.
  async getThreadMessages(chatId, rootSeq, { limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.chat_id, m.seq, m.sender_id, u.username AS sender_username,
              m.body, m.entities, m.sent_at, m.expires_at, m.thread_root_seq
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = $1 AND m.thread_root_seq = $2 AND m.deleted_at IS NULL
        ORDER BY m.seq
        LIMIT $3`,
      [chatId, rootSeq, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      seq: Number(row.seq),
      senderId: row.sender_id,
      senderUsername: row.sender_username,
      body: row.body,
      entities: row.entities,
      threadRootSeq: Number(row.thread_root_seq),
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
    }));
  },

  async getBySeq(chatId, seq) {
    const res = await this.pool.query(
      `SELECT id, chat_id, seq, sender_id, type, body, reactions, sent_at, expires_at
         FROM messages
        WHERE chat_id = $1 AND seq = $2 AND deleted_at IS NULL`,
      [chatId, seq]
    );
    return res.rows[0] || null;
  },

  // Edits a cloud message in place. Returns null when the message does not
  // exist or the caller does not own it — the route turns that into a 404 or
  // 403 rather than this layer deciding policy.
  async editCloudMessage(chatId, seq, senderId, { body, entities = null }) {
    const res = await this.pool.query(
      `UPDATE messages
          SET body = $4,
              entities = $5,
              edited_at = now()
        WHERE chat_id = $1
          AND seq = $2
          AND sender_id = $3
          AND deleted_at IS NULL
        RETURNING id, chat_id, seq, sender_id, body, entities, edited_at, sent_at, expires_at`,
      [chatId, seq, senderId, body, entities ? JSON.stringify(entities) : null]
    );
    return res.rows[0] || null;
  },
  };
}
