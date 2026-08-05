// ============================================================
// Vault — Phase 3 Routes
// ============================================================
// Admin rights, revocable invites, bans, polls and folders.
//
// Every mutating endpoint here resolves the caller's rights server-side via
// `phase3.can()`. A client's idea of its own role is a UI hint and is never
// trusted — that is the whole point of replacing the old join_key, which
// granted permanent access to anyone who had ever seen it.

import { UUID_PATTERN } from '../utils/constants.js';

async function phase3Routes(fastify) {
  const chatParam = { type: 'string', pattern: UUID_PATTERN };

  async function requireRight(request, reply, chatId, right) {
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      reply.code(404).send({ error: 'Chat not found' });
      return false;
    }
    if (!(await fastify.repos.phase3.can(chatId, request.user.id, right))) {
      reply.code(403).send({ error: 'You do not have permission to do that' });
      return false;
    }
    return true;
  }

  // ─── Invites ────────────────────────────────────────────

  fastify.post('/api/chats/:chatId/invites', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        properties: {
          expiresAt: { type: ['string', 'null'] },
          usageLimit: { type: ['integer', 'null'], minimum: 1, maximum: 100000 },
          title: { type: ['string', 'null'], maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'manageInvites'))) return undefined;

    const invite = await fastify.repos.phase3.createInvite(
      chatId, request.user.id, request.body || {}
    );
    return reply.code(201).send(invite);
  });

  fastify.get('/api/chats/:chatId/invites', {
    preValidation: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } } },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'manageInvites'))) return undefined;
    return { invites: await fastify.repos.phase3.listInvites(chatId) };
  });

  fastify.delete('/api/chats/:chatId/invites/:hash', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'hash'],
        properties: { chatId: chatParam, hash: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, hash } = request.params;
    if (!(await requireRight(request, reply, chatId, 'manageInvites'))) return undefined;

    await fastify.repos.phase3.revokeInvite(hash);
    return reply.send({ revoked: hash });
  });

  // Redeeming needs no rights — that is what an invite is for — but it is
  // still subject to bans, expiry, revocation and usage limits.
  fastify.post('/api/invites/:hash/join', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object', required: ['hash'],
        properties: { hash: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const result = await fastify.repos.phase3.redeemInvite(request.params.hash, request.user.id);
    if (!result.ok) return reply.code(403).send({ error: result.reason });

    const chat = await fastify.repos.chats.get(result.chatId);
    const memberIds = await fastify.repos.chats.memberIds(result.chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'group_updated', groupId: result.chatId, group: chat, membershipChange: 'joined',
    });

    return reply.code(200).send(chat);
  });

  // ─── Roles and bans ─────────────────────────────────────

  fastify.patch('/api/chats/:chatId/members/:userId/role', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'userId'],
        properties: { chatId: chatParam, userId: chatParam },
      },
      body: {
        type: 'object', required: ['role'],
        properties: { role: { type: 'string', enum: ['admin', 'member', 'restricted'] } },
      },
    },
  }, async (request, reply) => {
    const { chatId, userId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'promote'))) return undefined;

    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'You cannot change your own role' });
    }

    const updated = await fastify.repos.phase3.setRole(chatId, userId, request.body.role);
    if (!updated) return reply.code(404).send({ error: 'Member not found' });

    return reply.send(updated);
  });

  fastify.post('/api/chats/:chatId/members/:userId/ban', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'userId'],
        properties: { chatId: chatParam, userId: chatParam },
      },
      body: { type: 'object', properties: { until: { type: ['string', 'null'] } } },
    },
  }, async (request, reply) => {
    const { chatId, userId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'ban'))) return undefined;

    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'You cannot ban yourself' });
    }

    // An admin must not be able to ban someone with authority over them.
    const targetRights = await fastify.repos.phase3.rightsFor(chatId, userId);
    if (targetRights?.has('promote')) {
      return reply.code(403).send({ error: 'You cannot ban the chat owner' });
    }

    await fastify.repos.phase3.ban(chatId, userId, request.user.id, request.body || {});
    await fastify.fanout.deliverToUser(userId, { type: 'group_removed', groupId: chatId });

    return reply.send({ banned: userId });
  });

  fastify.delete('/api/chats/:chatId/members/:userId/ban', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'userId'],
        properties: { chatId: chatParam, userId: chatParam },
      },
    },
  }, async (request, reply) => {
    const { chatId, userId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'ban'))) return undefined;

    await fastify.repos.phase3.unban(chatId, userId);
    return reply.send({ unbanned: userId });
  });

  fastify.get('/api/chats/:chatId/rights', {
    preValidation: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } } },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    if (!rights) return reply.code(404).send({ error: 'Chat not found' });
    return { rights: [...rights].sort() };
  });

  // ─── Polls ──────────────────────────────────────────────

  fastify.post('/api/chats/:chatId/polls', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        required: ['question', 'options'],
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 300 },
          options: {
            type: 'array', minItems: 2, maxItems: 10,
            items: { type: 'string', minLength: 1, maxLength: 100 },
          },
          isAnonymous: { type: 'boolean', default: true },
          allowsMultiple: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireRight(request, reply, chatId, 'post'))) return undefined;

    const chat = await fastify.repos.chats.get(chatId);
    if (chat.mode !== 'cloud') {
      return reply.code(400).send({
        error: 'Polls in end-to-end encrypted chats must be run client-side',
      });
    }

    const { question, options, isAnonymous, allowsMultiple } = request.body;

    const stored = await fastify.repos.messages.createCloudMessage({
      chatId, senderId: request.user.id, type: 'poll',
      body: question, entities: null, media: null,
      ttlSeconds: fastify.repos.chats.resolveTtlSeconds({
        chatDefaultSeconds: chat.defaultTtlSecs,
      }),
    });

    const poll = await fastify.repos.phase3.createPoll(chatId, Number(stored.seq), {
      question, options, isAnonymous, allowsMultiple,
    });

    const results = await fastify.repos.phase3.getPollResults(poll.id, request.user.id);
    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'message',
      data: {
        id: stored.id, chatId, seq: Number(stored.seq),
        senderId: request.user.id, senderUsername: request.user.username,
        messageType: 'poll', body: question, poll: results,
        sentAt: stored.sent_at, expiresAt: stored.expires_at, mode: 'cloud',
      },
    });

    return reply.code(201).send({ seq: Number(stored.seq), poll: results });
  });

  fastify.post('/api/chats/:chatId/messages/:seq/vote', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object', required: ['optionIds'],
        properties: {
          optionIds: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'integer', minimum: 0 } },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const pollId = await fastify.repos.phase3.getPollForMessage(chatId, seq);
    if (!pollId) return reply.code(404).send({ error: 'Poll not found' });

    const result = await fastify.repos.phase3.vote(pollId, request.user.id, request.body.optionIds);
    if (!result.ok) return reply.code(400).send({ error: result.reason });

    const results = await fastify.repos.phase3.getPollResults(pollId, request.user.id);
    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'poll_updated', chatId, seq: Number(seq),
    });

    return reply.send({ poll: results });
  });

  fastify.get('/api/chats/:chatId/messages/:seq/poll', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
    const pollId = await fastify.repos.phase3.getPollForMessage(chatId, seq);
    if (!pollId) return reply.code(404).send({ error: 'Poll not found' });

    return { poll: await fastify.repos.phase3.getPollResults(pollId, request.user.id) };
  });

  // ─── View-once media ────────────────────────────────────
  //
  // Cloud only, and deliberately so. In a secret chat the server holds no
  // content to clear, so "view once" there is a client-side promise the same
  // way burn-on-read already is — enforcing it here would be theatre.

  fastify.post('/api/chats/:chatId/messages/:seq/view', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const result = await fastify.repos.phase3.recordView(chatId, seq, request.user.id);
    if (!result.ok) return reply.code(404).send({ error: 'Message not found' });

    if (result.consumed) {
      // Everyone except the viewer. They are looking at it right now — having
      // opened it deliberately — and clearing their copy in the same instant
      // would mean the one person entitled to see it never does. It is gone
      // for them on the next load, which is what "view once" means.
      const memberIds = await fastify.repos.chats.memberIds(chatId);
      await fastify.fanout.deliverToUsers(memberIds, {
        type: 'message_consumed', chatId, seq: Number(seq),
      }, { exclude: [request.user.id] });
    }

    return reply.send({ consumed: result.consumed });
  });

  // ─── Folders ────────────────────────────────────────────

  fastify.get('/api/folders', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({ folders: await fastify.repos.phase3.listFolders(request.user.id) }));

  fastify.post('/api/folders', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object', required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 50 },
          emoji: { type: ['string', 'null'], maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const folder = await fastify.repos.phase3.createFolder(request.user.id, request.body);
    return reply.code(201).send(folder);
  });

  fastify.put('/api/folders/:folderId/chats', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['folderId'], properties: { folderId: { type: 'integer' } } },
      body: {
        type: 'object', required: ['chatIds'],
        properties: { chatIds: { type: 'array', maxItems: 500, items: chatParam } },
      },
    },
  }, async (request, reply) => {
    const ok = await fastify.repos.phase3.setFolderChats(
      request.user.id, request.params.folderId, request.body.chatIds
    );
    if (!ok) return reply.code(404).send({ error: 'Folder not found' });
    return reply.send({ folderId: request.params.folderId });
  });

  fastify.delete('/api/folders/:folderId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['folderId'], properties: { folderId: { type: 'integer' } } },
    },
  }, async (request, reply) => {
    await fastify.repos.phase3.deleteFolder(request.user.id, request.params.folderId);
    return reply.send({ deleted: request.params.folderId });
  });
}

export default phase3Routes;
