// ============================================================
// Vault — Chat Routes
// ============================================================
// The chat list and per-chat state.
//
// This is the API the sidebar reads. It returns chats, not conversations
// inferred from message rows, which is what makes an emptied-out chat still
// appear: messages expire after 24 hours, chats do not.

import { UUID_PATTERN } from '../utils/constants.js';

async function chatRoutes(fastify) {

  // ─── LIST chats ───────────────────────────────────────────
  fastify.get('/api/chats', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          archived: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request) => {
    const chats = await fastify.repos.chats.listForUser(request.user.id, {
      includeArchived: request.query.archived === true,
    });
    return { chats };
  });

  // ─── GET one chat ─────────────────────────────────────────
  fastify.get('/api/chats/:chatId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: { chatId: { type: 'string', pattern: UUID_PATTERN } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;

    // Membership is checked before existence is revealed, so probing for a
    // chat id tells an outsider nothing either way.
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    return chat;
  });

  // ─── OPEN a private chat with a peer ──────────────────────
  // Idempotent: the id is derived from the pair, so calling this from both
  // sides at once converges on one chat rather than racing.
  fastify.post('/api/chats/private', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['peerId'],
        properties: {
          peerId: { type: 'string', pattern: UUID_PATTERN },
          // One-to-one chats are end-to-end encrypted by default. This is
          // the conversation people assume is private, so the safe mode is
          // the one you get without asking; `cloud` is opt-in per chat.
          mode: { type: 'string', enum: ['cloud', 'secret'], default: 'secret' },
        },
      },
    },
  }, async (request, reply) => {
    const { peerId, mode } = request.body;

    if (peerId === request.user.id) {
      return reply.code(400).send({ error: 'Cannot open a private chat with yourself' });
    }

    const peer = await fastify.repos.users.getUserById(peerId);
    if (!peer) return reply.code(404).send({ error: 'User not found' });

    if (await fastify.repos.phase2.isBlockedBetween(request.user.id, peerId)) {
      return reply.code(403).send({ error: 'You cannot start a chat with this user' });
    }

    const chatId = await fastify.repos.chats.ensurePrivateChat(request.user.id, peerId, { mode });
    return reply.code(201).send(await fastify.repos.chats.get(chatId));
  });

  // ─── MARK READ ────────────────────────────────────────────
  fastify.post('/api/chats/:chatId/read', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: { chatId: { type: 'string', pattern: UUID_PATTERN } },
      },
      body: {
        type: 'object',
        required: ['maxSeq'],
        properties: { maxSeq: { type: 'integer', minimum: 0 } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;

    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const state = await fastify.repos.chats.readHistory(
      chatId, request.user.id, request.body.maxSeq
    );

    // Tell the reader's other devices so the badge clears everywhere, and the
    // sender so their ticks update.
    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'read_history',
      chatId,
      userId: request.user.id,
      maxSeq: request.body.maxSeq,
    });

    return reply.send({
      readInboxMaxSeq: Number(state.read_inbox_max_seq),
      unreadCount: Number(state.unread_count),
    });
  });

  // ─── DELETE a chat, for yourself ──────────────────────────
  // Removes the conversation from your list and its history from your view.
  // **It does not touch the other participant's copy**, and there is
  // deliberately no flag to make it do so: see migration 0021. The name is
  // "delete" because that is what it does to everything the caller can see,
  // and the client copy says plainly that it is one-sided.
  //
  // Not a DELETE of the chat row or of chat_members — dropping membership
  // would stop the other person delivering into the conversation, turning
  // this into a block they were never told about.
  fastify.delete('/api/chats/:chatId', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: { chatId: { type: 'string', pattern: UUID_PATTERN } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;

    // 404 rather than 403, matching every other route here: whether a chat
    // exists is not something to confirm to someone who is not in it.
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    await fastify.repos.chats.clearFor(chatId, request.user.id);

    // The caller's *other* devices, and nobody else's. Sending this to every
    // member would tell the other participant that you deleted the
    // conversation, which they have no business knowing and which the
    // one-sided semantics promise they will not learn.
    await fastify.fanout.deliverToUser(request.user.id, {
      type: 'chat_deleted',
      chatId,
    });

    return reply.code(204).send();
  });
}

export default chatRoutes;
