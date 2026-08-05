// ============================================================
// Vault — Phase 2 Routes
// ============================================================
// Deletion, pins, forwarding, drafts, chat settings, blocking, presence and
// search.
//
// Two guards recur and are worth stating once:
//
//   - Membership is checked before existence is revealed, so probing a chat
//     id tells an outsider nothing. Non-members get 404, never 403.
//   - Anything that would have the server read or write message *content*
//     is refused for secret chats. Drafts and search are the notable ones:
//     both would hand the server exactly what an E2EE conversation exists to
//     withhold.

import { UUID_PATTERN } from '../utils/constants.js';
import { capabilities } from '../../../shared/capabilities.js';

async function phase2Routes(fastify) {
  const chatParam = { type: 'string', pattern: UUID_PATTERN };

  // Resolves a chat the caller belongs to, or replies 404 and returns null.
  async function memberChat(request, reply, chatId) {
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      reply.code(404).send({ error: 'Chat not found' });
      return null;
    }
    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) {
      reply.code(404).send({ error: 'Chat not found' });
      return null;
    }
    return chat;
  }

  async function broadcast(chatId, payload) {
    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, payload);
  }

  // ─── DELETE a message ───────────────────────────────────
  fastify.delete('/api/chats/:chatId/messages/:seq', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
      querystring: {
        type: 'object',
        properties: {
          // Default is the conservative one: hiding it from yourself cannot
          // destroy anyone else's copy by accident.
          forEveryone: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    const { forEveryone } = request.query;

    const chat = await memberChat(request, reply, chatId);
    if (!chat) return undefined;

    if (!forEveryone) {
      await fastify.repos.phase2.deleteForMe(chatId, seq, request.user.id);
      return reply.send({ chatId, seq, scope: 'me' });
    }

    if (!capabilities(chat).isCloud) {
      return reply.code(400).send({
        error: 'This chat is end-to-end encrypted; send the deletion as an encrypted op',
      });
    }

    const existing = await fastify.repos.messages.getBySeq(chatId, seq);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    // Only the author may unsend. Anyone else erasing a message would let a
    // participant rewrite history for everyone in the room.
    if (existing.sender_id !== request.user.id) {
      return reply.code(403).send({ error: 'Only the sender can delete for everyone' });
    }

    const deleted = await fastify.repos.phase2.deleteForEveryone(chatId, seq, request.user.id);
    if (!deleted) return reply.code(404).send({ error: 'Message not found' });

    await broadcast(chatId, { type: 'message_deleted', chatId, seq: Number(seq) });
    return reply.send({ chatId, seq, scope: 'everyone' });
  });

  // ─── PIN / UNPIN ────────────────────────────────────────
  fastify.post('/api/chats/:chatId/messages/:seq/pin', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await memberChat(request, reply, chatId))) return undefined;

    const pinned = await fastify.repos.phase2.pin(chatId, seq, request.user.id);
    if (!pinned) return reply.code(404).send({ error: 'Message not found' });

    await broadcast(chatId, {
      type: 'message_pinned', chatId, seq: Number(seq), pinnedBy: request.user.id,
    });
    return reply.send({ chatId, seq: Number(seq), pinnedAt: pinned.pinned_at });
  });

  fastify.delete('/api/chats/:chatId/messages/:seq/pin', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await memberChat(request, reply, chatId))) return undefined;

    await fastify.repos.phase2.unpin(chatId, seq);
    await broadcast(chatId, { type: 'message_unpinned', chatId, seq: Number(seq) });
    return reply.send({ chatId, seq: Number(seq) });
  });

  fastify.get('/api/chats/:chatId/pinned', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await memberChat(request, reply, chatId))) return undefined;
    return { pinned: await fastify.repos.phase2.listPinned(chatId) };
  });

  // ─── FORWARD ────────────────────────────────────────────
  fastify.post('/api/chats/:chatId/forward', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        required: ['toChatId', 'seqs'],
        properties: {
          toChatId: chatParam,
          seqs: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const { toChatId, seqs } = request.body;

    const source = await memberChat(request, reply, chatId);
    if (!source) return undefined;

    if (!(await fastify.repos.chats.isMember(toChatId, request.user.id))) {
      return reply.code(404).send({ error: 'Destination chat not found' });
    }
    const destination = await fastify.repos.chats.get(toChatId);
    if (!destination) return reply.code(404).send({ error: 'Destination chat not found' });

    if (!capabilities(destination).isCloud) {
      return reply.code(400).send({
        error: 'Forwarding into an end-to-end encrypted chat must be done client-side',
      });
    }

    const forwarded = [];
    for (const seq of seqs) {
      const original = await fastify.repos.messages.getBySeq(chatId, seq);
      if (!original || !original.body) continue;

      // Attribution is only carried when the source is a cloud chat. Copying
      // it out of a secret chat would create a server-side record pointing
      // back into an encrypted conversation — content the server should not
      // be able to associate with anything.
      const attributed = capabilities(source).isCloud;

      const stored = await fastify.repos.messages.createCloudMessage({
        chatId: toChatId,
        senderId: request.user.id,
        type: 'text',
        body: original.body,
        entities: null,
        media: null,
        ttlSeconds: fastify.repos.chats.resolveTtlSeconds({
          chatDefaultSeconds: destination.defaultTtlSecs,
        }),
        fwdFromChat: attributed ? chatId : null,
        fwdFromSeq: attributed ? seq : null,
      });

      forwarded.push({ seq: Number(stored.seq), id: stored.id });

      await broadcast(toChatId, {
        type: 'message',
        data: {
          id: stored.id,
          chatId: toChatId,
          seq: Number(stored.seq),
          senderId: request.user.id,
          senderUsername: request.user.username,
          messageType: 'text',
          body: original.body,
          forwarded: true,
          sentAt: stored.sent_at,
          expiresAt: stored.expires_at,
          mode: 'cloud',
        },
      });
    }

    if (forwarded.length === 0) {
      return reply.code(400).send({ error: 'Nothing to forward' });
    }
    return reply.code(201).send({ forwarded });
  });

  // ─── DRAFTS ─────────────────────────────────────────────
  fastify.put('/api/chats/:chatId/draft', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', maxLength: 8192 },
          replyToSeq: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const chat = await memberChat(request, reply, chatId);
    if (!chat) return undefined;

    // A draft is plaintext. Syncing one for an E2EE conversation would hand
    // the server the very content that conversation exists to withhold, so
    // secret-chat drafts stay on the device.
    if (!capabilities(chat).isCloud) {
      return reply.code(400).send({
        error: 'Drafts for end-to-end encrypted chats are kept on the device',
      });
    }

    const { body, replyToSeq = null } = request.body;
    if (!body.trim()) {
      await fastify.repos.phase2.clearDraft(chatId, request.user.id);
      return reply.send({ chatId, cleared: true });
    }

    const saved = await fastify.repos.phase2.saveDraft(chatId, request.user.id, { body, replyToSeq });
    return reply.send({ chatId, body: saved.body, updatedAt: saved.updated_at });
  });

  fastify.get('/api/drafts', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({ drafts: await fastify.repos.phase2.listDrafts(request.user.id) }));

  // ─── CHAT SETTINGS ──────────────────────────────────────
  fastify.patch('/api/chats/:chatId/settings', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        properties: {
          mutedUntil: { type: ['string', 'null'] },
          archived: { type: ['boolean', 'null'] },
          pinnedOrder: { type: ['integer', 'null'] },
          ttlSecs: { type: ['integer', 'null'], minimum: 1, maximum: 86400 },
          // A named theme, not a colour: accepting arbitrary CSS from a
          // client would let one user hand another's browser whatever it
          // liked. The client maps the name to a palette it already ships.
          theme: { type: ['string', 'null'], maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await memberChat(request, reply, chatId))) return undefined;

    const patch = request.body || {};

    // Explicit nulls mean "clear", which COALESCE in the upsert cannot
    // express on its own.
    if (Object.prototype.hasOwnProperty.call(patch, 'mutedUntil') && patch.mutedUntil === null) {
      await fastify.repos.phase2.unmute(chatId, request.user.id);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'pinnedOrder') && patch.pinnedOrder === null) {
      await fastify.repos.phase2.unpinChat(chatId, request.user.id);
    }
    // Null means "back to the default palette" — passed down as '' because
    // the upsert reads null as "leave this column alone".
    if (Object.prototype.hasOwnProperty.call(patch, 'theme') && patch.theme === null) {
      patch.theme = '';
    }

    const settings = await fastify.repos.phase2.updateChatSettings(chatId, request.user.id, patch);
    return reply.send(settings);
  });

  // ─── BLOCKING ───────────────────────────────────────────
  fastify.post('/api/users/:userId/block', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: chatParam } },
    },
  }, async (request, reply) => {
    const { userId } = request.params;
    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'You cannot block yourself' });
    }
    if (!(await fastify.repos.users.getUserById(userId))) {
      return reply.code(404).send({ error: 'User not found' });
    }
    await fastify.repos.phase2.block(request.user.id, userId);
    return reply.code(201).send({ blocked: userId });
  });

  fastify.delete('/api/users/:userId/block', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: chatParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.phase2.unblock(request.user.id, request.params.userId);
    return reply.send({ unblocked: request.params.userId });
  });

  fastify.get('/api/blocks', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({ blocked: await fastify.repos.phase2.listBlocked(request.user.id) }));

  // ─── PRESENCE ───────────────────────────────────────────
  fastify.get('/api/presence', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['userIds'],
        properties: { userIds: { type: 'string' } },  // comma-separated
      },
    },
  }, async (request, reply) => {
    const ids = request.query.userIds.split(',').filter((id) => UUID_RE.test(id)).slice(0, 100);
    if (ids.length === 0) return reply.send({ presence: [] });

    const stored = await fastify.repos.phase2.getPresence(ids);

    // Live connection state wins over the stored last-seen: someone connected
    // right now is online regardless of when they were last written down.
    const presence = await Promise.all(stored.map(async (p) => ({
      userId: p.userId,
      online: p.privacy === 'nobody' ? false : await fastify.store.registry.isOnline(p.userId),
      lastSeenAt: p.lastSeenAt,
    })));

    return reply.send({ presence });
  });

  // ─── SEARCH ─────────────────────────────────────────────
  fastify.get('/api/search/messages', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', minLength: 2, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request) => {
    const results = await fastify.repos.phase2.searchMessages(
      request.user.id, request.query.q, { limit: request.query.limit }
    );

    return {
      results,
      // Stated so a client never has to infer why older matches are missing,
      // and so the UI can say "your last 24 hours" rather than implying the
      // search covers everything.
      retentionSeconds: 86400,
      // Secret chats cannot be searched server-side: they have no plaintext
      // body to index. Clients should say so rather than silently omitting.
      excludesSecretChats: true,
    };
  });
}

const UUID_RE = new RegExp(UUID_PATTERN);

export default phase2Routes;
