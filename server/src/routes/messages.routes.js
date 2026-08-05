// ============================================================
// Vault — Message Routes
// Encrypted blob handling + paginated fetch
// Server is a BLIND RELAY — never decrypts anything
// ============================================================

import { MAX_TTL_MINUTES, MAX_MESSAGE_SIZE_BYTES, UUID_PATTERN, MAX_USERNAME_LENGTH } from '../utils/constants.js';

async function messageRoutes(fastify) {

  // ─── SEND encrypted message ───────────────────────────────
  fastify.post('/api/messages', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['recipientId', 'ciphertext', 'ephemeralKey', 'messageNumber'],
        properties: {
          recipientId:    { type: 'string', pattern: UUID_PATTERN },
          ciphertext:     { type: 'string', maxLength: MAX_MESSAGE_SIZE_BYTES },
          ephemeralKey:   { type: 'string', maxLength: 2000 },
          messageNumber:  { type: 'integer', minimum: 0 },
          previousChain:  { type: 'integer', minimum: 0, default: 0 },
          ttlMinutes:     { type: 'integer', minimum: 1, maximum: MAX_TTL_MINUTES, default: MAX_TTL_MINUTES },
          iv:             { type: 'string', maxLength: 100 },
          // These two are optional, and a client that has nothing to put in
          // them may send an explicit null rather than omitting the key.
          // AJV type coercion turns a null into '' for a plain string type,
          // which then fails the UUID pattern and 400s the whole send — so
          // null has to be an accepted type here (`pattern` only ever
          // applies to strings, so a real value is still validated).
          groupId:        { type: ['string', 'null'], pattern: UUID_PATTERN },
          attachmentId:   { type: ['string', 'null'], pattern: UUID_PATTERN },
          // Optional: names the chat this message belongs to so it can be
          // allocated a per-chat seq and therefore be referenced by
          // reactions, replies and pins.
          chatId:         { type: ['string', 'null'], pattern: UUID_PATTERN },
        },
      },
    },
  }, async (request, reply) => {
    const { recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, ttlMinutes, iv, groupId, attachmentId, chatId } = request.body;
    const senderId = request.user.id;

    // Validate recipient exists
    const recipient = await fastify.store.getUserById(recipientId);
    if (!recipient) {
      return reply.code(404).send({ error: 'Recipient not found' });
    }

    // Blocking is enforced here rather than only recorded. It is checked in
    // both directions: the blocker should not receive from the blocked, and
    // the blocked should not be able to reach the blocker.
    //
    // 403 with a neutral message, deliberately — telling a sender "you have
    // been blocked" hands them information the person who blocked them did
    // not choose to share.
    if (await fastify.repos.phase2.isBlockedBetween(senderId, recipientId)) {
      return reply.code(403).send({ error: 'Message could not be delivered' });
    }

    // If tagged with a group, the sender must actually be a member —
    // otherwise anyone could spoof messages as belonging to a group they're not in.
    if (groupId) {
      const group = await fastify.store.getGroup(groupId);
      if (!group || !group.members.some(m => m.id === senderId)) {
        return reply.code(403).send({ error: 'Not a member of this group' });
      }
    }

    // Enforce 24h hard ceiling
    const ttl = Math.min(ttlMinutes || MAX_TTL_MINUTES, MAX_TTL_MINUTES);
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();

    // The recipient has to be allowed to fetch the file. This lived in the
    // messages repo and called a method that repo does not have, so it threw
    // rather than authorising — every attachment sent in a secret chat 500'd.
    if (attachmentId) {
      await fastify.repos.attachments.authorizeAttachmentUser(attachmentId, recipientId);
    }

    // Store encrypted blob
    const msg = await fastify.store.createMessage({
      senderId,
      recipientId,
      ciphertext,
      ephemeralKey,
      messageNumber,
      previousChain: previousChain || 0,
      expiresAt,
      iv,
      groupId,
      attachmentId,
      // Only honoured when the sender is actually in that chat.
      chatId: chatId && await fastify.repos.chats.isMember(chatId, senderId) ? chatId : null,
    });

    // Attempt real-time WebSocket delivery
    let delivered = false;
    if (await fastify.store.registry.isOnline(recipientId)) {
      let groupName = null;
      let groupMembers = null;
      if (groupId) {
        const groupObj = await fastify.store.getGroup(groupId);
        if (groupObj) {
          groupName = groupObj.name;
          groupMembers = groupObj.members;
        }
      }

      const payload = JSON.stringify({
        type: 'message',
        data: {
          id: msg.id,
          chatId: msg.chat_id,
          seq: msg.seq === null ? null : Number(msg.seq),
          senderId,
          senderUsername: request.user.username,
          ciphertext,
          ephemeralKey,
          iv,
          messageNumber,
          previousChain: msg.previous_chain,
          sentAt: msg.sent_at,
          expiresAt: msg.expires_at,
          groupId,
          groupName,
          groupMembers
        },
      });

      delivered = (await fastify.fanout.deliverToUser(recipientId, payload)) > 0;
    }

    // If not delivered, enqueue for later delivery. The message itself is
    // already persisted above, so a failure here (bad push subscription,
    // transient store error) must never fail the send for the caller.
    if (!delivered) {
      try {
        await fastify.store.enqueuePending(recipientId, msg.id);

        let groupName = null;
        if (groupId) {
          try {
            const groupObj = await fastify.store.getGroup(groupId);
            if (groupObj) {
              groupName = groupObj.name;
            }
          } catch {}
        }

        await fastify.sendPushNotification(recipientId, {
          title: groupName ? `@${groupName}` : `@${request.user.username}`,
          body: groupName ? `@${request.user.username}: Sent an encrypted message` : 'Sent an encrypted message'
        });
      } catch (err) {
        fastify.log.warn({ err }, 'Failed to enqueue/notify offline recipient');
      }
    } else {
      await fastify.store.markDelivered(msg.id);
    }

    // Send delivery confirmation back to sender's other connections
    {
      const ack = JSON.stringify({
        type: 'sent',
        data: {
          id: msg.id,
          recipientId,
          sentAt: msg.sent_at,
          delivered,
        },
      });
      await fastify.fanout.deliverToUser(senderId, ack);
    }

    return reply.code(201).send({
      id: msg.id,
      chatId: msg.chat_id,
      seq: msg.seq === null ? null : Number(msg.seq),
      sentAt: msg.sent_at,
      expiresAt: msg.expires_at,
      delivered,
    });
  });

  // ─── FETCH conversation messages (paginated) ──────────────
  fastify.get('/api/messages/:peerId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['peerId'],
        properties: { peerId: { type: 'string', pattern: UUID_PATTERN } },
      },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          before: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { peerId } = request.params;
    const { limit, before } = request.query;
    const messages = await fastify.store.getConversationMessages(
      request.user.id, peerId, limit || 50, before
    );
    return { messages, hasMore: messages.length === (limit || 50) };
  });

  // ─── FETCH all undelivered messages ───────────────────────
  fastify.get('/api/messages/pending/all', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const messages = await fastify.store.getUndeliveredMessages(request.user.id);
    // Mark as delivered now that client has fetched them
    for (const msg of messages) {
      await fastify.store.markDelivered(msg.id);
      await fastify.store.removePending(request.user.id, msg.id);
    }
    return { messages };
  });

  // ─── LIST conversations ───────────────────────────────────
  fastify.get('/api/conversations', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const conversations = await fastify.store.getConversationsForUser(request.user.id);
    return { conversations };
  });

  // ─── SEARCH users ────────────────────────────────────────
  fastify.get('/api/users/search', {
    preValidation: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          // A short substring query (e.g. a single letter) matches most of
          // the user table, turning search into a full user-enumeration
          // tool. Requiring a longer, prefix-anchored query (see
          // searchUsers) means a caller has to already know most of a
          // real username rather than being able to sweep the userbase.
          q: { type: 'string', minLength: 3, maxLength: MAX_USERNAME_LENGTH },
        },
      },
    },
  }, async (request) => {
    const results = await fastify.store.searchUsers(request.query.q, request.user.id);
    return { users: results };
  });
}

export default messageRoutes;
