// ============================================================
// Vault — Reaction Routes
// ============================================================
// Cloud-chat reactions.
//
// Secret chats are refused here on purpose. Their reactions ride the ratchet
// as `t:'op'` envelopes through the ordinary message path, so accepting one
// here would mean the server recording, in plaintext, who reacted to what in
// a conversation it is not supposed to be able to read. Same reasoning as the
// plaintext guard on cloud message sends.

import { UUID_PATTERN } from '../utils/constants.js';
import { capabilities } from '../../../shared/capabilities.js';

async function reactionRoutes(fastify) {

  const messageParams = {
    type: 'object',
    required: ['chatId', 'seq'],
    properties: {
      chatId: { type: 'string', pattern: UUID_PATTERN },
      seq: { type: 'integer', minimum: 1 },
    },
  };

  // Resolves the chat and checks the caller may react in it.
  async function authorize(request, reply) {
    const { chatId } = request.params;

    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      reply.code(404).send({ error: 'Chat not found' });
      return null;
    }

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) {
      reply.code(404).send({ error: 'Chat not found' });
      return null;
    }

    if (!capabilities(chat).isCloud) {
      reply.code(400).send({
        error: 'This chat is end-to-end encrypted; send the reaction as an encrypted op',
      });
      return null;
    }

    return chat;
  }

  async function broadcast(chatId, seq, summary, actorId) {
    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'reaction',
      chatId,
      seq,
      reactions: summary,
      actorId,
    });
  }

  // ─── ADD ──────────────────────────────────────────────────
  fastify.post('/api/chats/:chatId/messages/:seq/reactions', {
    preValidation: [fastify.authenticate],
    schema: {
      params: messageParams,
      body: {
        type: 'object',
        required: ['emoji'],
        properties: { emoji: { type: 'string', minLength: 1, maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const chat = await authorize(request, reply);
    if (!chat) return undefined;

    const { chatId, seq } = request.params;
    const { emoji } = request.body;

    const message = await fastify.repos.messages.getBySeq(chatId, seq);
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    const summary = await fastify.repos.reactions.add(chatId, seq, request.user.id, emoji);
    await broadcast(chatId, seq, summary, request.user.id);

    return reply.code(201).send({ chatId, seq, reactions: summary });
  });

  // ─── REMOVE ───────────────────────────────────────────────
  fastify.delete('/api/chats/:chatId/messages/:seq/reactions/:emoji', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId', 'seq', 'emoji'],
        properties: {
          chatId: { type: 'string', pattern: UUID_PATTERN },
          seq: { type: 'integer', minimum: 1 },
          emoji: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const chat = await authorize(request, reply);
    if (!chat) return undefined;

    const { chatId, seq } = request.params;
    const emoji = decodeURIComponent(request.params.emoji);

    const summary = await fastify.repos.reactions.remove(chatId, seq, request.user.id, emoji);
    await broadcast(chatId, seq, summary, request.user.id);

    return reply.send({ chatId, seq, reactions: summary });
  });
}

export default reactionRoutes;
