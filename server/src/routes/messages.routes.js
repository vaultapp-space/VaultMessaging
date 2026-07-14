// ============================================================
// Vault — Message Routes
// Encrypted blob handling + paginated fetch
// Server is a BLIND RELAY — never decrypts anything
// ============================================================

import { MAX_TTL_MINUTES, MAX_MESSAGE_SIZE_BYTES } from '../utils/constants.js';
import config from '../config.js';

async function messageRoutes(fastify) {

  // ─── SEND encrypted message ───────────────────────────────
  fastify.post('/api/messages', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['recipientId', 'ciphertext', 'ephemeralKey', 'messageNumber'],
        properties: {
          recipientId:    { type: 'string', maxLength: 100 },
          ciphertext:     { type: 'string', maxLength: MAX_MESSAGE_SIZE_BYTES },
          ephemeralKey:   { type: 'string', maxLength: 2000 },
          messageNumber:  { type: 'integer', minimum: 0 },
          previousChain:  { type: 'integer', minimum: 0, default: 0 },
          ttlMinutes:     { type: 'integer', minimum: 1, maximum: MAX_TTL_MINUTES, default: MAX_TTL_MINUTES },
          iv:             { type: 'string', maxLength: 100 },
          groupId:        { type: 'string', maxLength: 100 },
          attachmentId:   { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, ttlMinutes, iv, groupId, attachmentId } = request.body;
    const senderId = request.user.id;

    // Validate recipient exists
    const recipient = await fastify.store.getUserById(recipientId);
    if (!recipient) {
      return reply.code(404).send({ error: 'Recipient not found' });
    }

    // Enforce 24h hard ceiling
    const ttl = Math.min(ttlMinutes || MAX_TTL_MINUTES, MAX_TTL_MINUTES);
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();

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
      attachmentId
    });

    // Attempt real-time WebSocket delivery
    let delivered = false;
    const sockets = fastify.store.getConnections(recipientId);
    if (sockets.size > 0) {
      let groupName = null;
      let groupMembers = null;
      let groupJoinKey = null;
      if (groupId) {
        const groupObj = await fastify.store.getGroup(groupId);
        if (groupObj) {
          groupName = groupObj.name;
          groupMembers = groupObj.members;
          groupJoinKey = groupObj.joinKey;
        }
      }

      const payload = JSON.stringify({
        type: 'message',
        data: {
          id: msg.id,
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
          groupMembers,
          groupJoinKey
        },
      });

      for (const socket of sockets) {
        try {
          socket.send(payload);
          delivered = true;
        } catch (err) {
          fastify.log.warn({ err }, 'Failed to deliver via WebSocket');
        }
      }
    }

    // If not delivered, enqueue for later delivery
    if (!delivered) {
      await fastify.store.enqueuePending(recipientId, msg.id);
      
      // Dispatch Web Push notification
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
    } else {
      await fastify.store.markDelivered(msg.id);
    }

    // Send delivery confirmation back to sender's other connections
    const senderSockets = fastify.store.getConnections(senderId);
    if (senderSockets.size > 0) {
      const ack = JSON.stringify({
        type: 'sent',
        data: {
          id: msg.id,
          recipientId,
          sentAt: msg.sent_at,
          delivered,
        },
      });
      for (const s of senderSockets) {
        try { s.send(ack); } catch {}
      }
    }

    return reply.code(201).send({
      id: msg.id,
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
        properties: { peerId: { type: 'string' } },
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
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request) => {
    const results = await fastify.store.searchUsers(request.query.q, request.user.id);
    return { users: results };
  });
}

export default messageRoutes;
