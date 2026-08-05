// ============================================================
// Vault — Voice chats, forum topics, stories
// ============================================================
// The Phase 8 long tail.
//
// **On voice chats:** what ships here is the room — who is in the call, who
// is muted, who is speaking — and signalling reuses the existing WebRTC
// relay. The media topology is still a 1:1 mesh, which is O(n²) connections
// and degrades badly past a handful of people, so the participant cap is
// enforced server-side and surfaced to the client. Scaling beyond it means
// running an SFU, which is new infrastructure rather than new code. The cap
// is the honest version: a call that says it holds four is better than one
// that quietly falls apart at eight.
//
// **On stories:** they inherit the 24-hour rule rather than defining their
// own. A story's "24 hours" happens to match the product's ceiling, which
// makes it tempting to treat it as a special case — it is not one, and the
// TTL is clamped like every other.

import { UUID_PATTERN } from '../utils/constants.js';

const chatParam = { type: 'string', pattern: UUID_PATTERN };
const MAX_CAPTION = 1024;

async function phase8Routes(fastify) {

  async function requireMember(request, reply, chatId) {
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      reply.code(404).send({ error: 'Chat not found' });
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Voice chats
  // ═══════════════════════════════════════════════════════════

  fastify.post('/api/chats/:chatId/voice', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        properties: { title: { type: ['string', 'null'], maxLength: 128 } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireMember(request, reply, chatId))) return undefined;

    const result = await fastify.repos.phase8.startVoiceChat(
      chatId, request.user.id, { title: request.body?.title ?? null }
    );
    if (!result.ok) return reply.code(400).send({ error: result.reason });

    if (result.created) {
      const memberIds = await fastify.repos.chats.memberIds(chatId);
      await fastify.fanout.deliverToUsers(memberIds, {
        type: 'voice_chat_started', chatId, voiceChat: result.voiceChat,
      });
    }

    return reply.code(result.created ? 201 : 200).send({
      ...result.voiceChat,
      maxParticipants: fastify.repos.phase8.maxVoiceParticipants,
    });
  });

  fastify.get('/api/chats/:chatId/voice', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireMember(request, reply, chatId))) return undefined;

    const voiceChat = await fastify.repos.phase8.liveVoiceChat(chatId);
    if (!voiceChat) return reply.send({ voiceChat: null });

    return reply.send({
      voiceChat,
      participants: await fastify.repos.phase8.voiceParticipants(voiceChat.id),
      maxParticipants: fastify.repos.phase8.maxVoiceParticipants,
    });
  });

  fastify.post('/api/voice/:voiceChatId/join', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['voiceChatId'],
        properties: { voiceChatId: chatParam },
      },
    },
  }, async (request, reply) => {
    const { voiceChatId } = request.params;
    const voiceChat = await fastify.repos.phase8.getVoiceChat(voiceChatId);
    if (!voiceChat) return reply.code(404).send({ error: 'Call not found' });
    if (!(await requireMember(request, reply, voiceChat.chatId))) return undefined;

    // The cap is enforced in a transaction, so several people joining at once
    // cannot each see room and collectively overfill a mesh call — which
    // would degrade it for everyone already in.
    const result = await fastify.repos.phase8.joinVoiceChat(voiceChatId, request.user.id);
    if (!result.ok) return reply.code(409).send({ error: result.reason });

    const participants = await fastify.repos.phase8.voiceParticipants(voiceChatId);
    const memberIds = await fastify.repos.chats.memberIds(voiceChat.chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'voice_chat_updated', chatId: voiceChat.chatId, voiceChatId, participants,
    });

    return reply.send({ participants });
  });

  fastify.post('/api/voice/:voiceChatId/leave', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['voiceChatId'],
        properties: { voiceChatId: chatParam },
      },
    },
  }, async (request, reply) => {
    const { voiceChatId } = request.params;
    const voiceChat = await fastify.repos.phase8.getVoiceChat(voiceChatId);
    if (!voiceChat) return reply.code(404).send({ error: 'Call not found' });

    const remaining = await fastify.repos.phase8.leaveVoiceChat(voiceChatId, request.user.id);

    const memberIds = await fastify.repos.chats.memberIds(voiceChat.chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: remaining === 0 ? 'voice_chat_ended' : 'voice_chat_updated',
      chatId: voiceChat.chatId,
      voiceChatId,
      participants: await fastify.repos.phase8.voiceParticipants(voiceChatId),
    });

    return reply.send({ remaining });
  });

  fastify.patch('/api/voice/:voiceChatId/mute', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['voiceChatId'],
        properties: { voiceChatId: chatParam },
      },
      body: {
        type: 'object', required: ['muted'],
        properties: {
          muted: { type: 'boolean' },
          // Muting someone else. Requires the `ban` right, and is recorded
          // separately so the target cannot simply un-mute themselves.
          userId: { type: ['string', 'null'], pattern: UUID_PATTERN },
        },
      },
    },
  }, async (request, reply) => {
    const { voiceChatId } = request.params;
    const { muted, userId = null } = request.body;

    const voiceChat = await fastify.repos.phase8.getVoiceChat(voiceChatId);
    if (!voiceChat) return reply.code(404).send({ error: 'Call not found' });
    if (!(await requireMember(request, reply, voiceChat.chatId))) return undefined;

    const target = userId ?? request.user.id;
    const byAdmin = target !== request.user.id;

    if (byAdmin) {
      const rights = await fastify.repos.phase3.rightsFor(voiceChat.chatId, request.user.id);
      if (!rights?.has('ban')) {
        return reply.code(403).send({ error: 'You cannot mute other participants' });
      }
    }

    const result = await fastify.repos.phase8.setVoiceMute(
      voiceChatId, target, muted, { byAdmin }
    );
    if (!result.ok) return reply.code(403).send({ error: result.reason });

    const memberIds = await fastify.repos.chats.memberIds(voiceChat.chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'voice_chat_updated',
      chatId: voiceChat.chatId,
      voiceChatId,
      participants: await fastify.repos.phase8.voiceParticipants(voiceChatId),
    });

    return reply.send({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Forum topics
  // ═══════════════════════════════════════════════════════════

  fastify.patch('/api/chats/:chatId/forum', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object', required: ['isForum'],
        properties: { isForum: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    if (!rights?.has('changeInfo')) {
      return reply.code(rights ? 403 : 404).send({ error: 'Not permitted' });
    }

    await fastify.repos.phase8.setForum(chatId, request.body.isForum);
    return reply.send({ isForum: request.body.isForum });
  });

  fastify.post('/api/chats/:chatId/topics', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object', required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 128 },
          iconEmoji: { type: ['string', 'null'], maxLength: 16 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireMember(request, reply, chatId))) return undefined;

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat?.isForum) {
      return reply.code(400).send({ error: 'This chat is not a forum' });
    }

    const topic = await fastify.repos.phase8.createTopic(
      chatId, request.user.id, request.body
    );

    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'topic_created', chatId, topic,
    });

    return reply.code(201).send(topic);
  });

  fastify.get('/api/chats/:chatId/topics', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireMember(request, reply, chatId))) return undefined;
    return reply.send({ topics: await fastify.repos.phase8.listTopics(chatId) });
  });

  fastify.patch('/api/chats/:chatId/topics/:topicId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'topicId'],
        properties: { chatId: chatParam, topicId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        properties: {
          closed: { type: ['boolean', 'null'] },
          pinned: { type: ['boolean', 'null'] },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId, topicId } = request.params;
    // Closing or pinning a topic is moderation, so it needs the pin right
    // rather than mere membership.
    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    if (!rights?.has('pin')) {
      return reply.code(rights ? 403 : 404).send({ error: 'Not permitted' });
    }

    if (typeof request.body.closed === 'boolean') {
      await fastify.repos.phase8.setTopicClosed(chatId, topicId, request.body.closed);
    }
    if (typeof request.body.pinned === 'boolean') {
      await fastify.repos.phase8.setTopicPinned(chatId, topicId, request.body.pinned);
    }

    return reply.send(await fastify.repos.phase8.getTopic(chatId, topicId));
  });

  // ═══════════════════════════════════════════════════════════
  // Contacts
  // ═══════════════════════════════════════════════════════════
  //
  // One-directional and silent. Adding someone does not notify them and does
  // not make them add you — a contact list is a private annotation on your
  // own account. It matters here because "contacts" is the default story
  // audience.

  fastify.post('/api/contacts/:userId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: chatParam } },
      body: {
        type: 'object',
        properties: {
          firstName: { type: ['string', 'null'], maxLength: 64 },
          lastName:  { type: ['string', 'null'], maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const { userId } = request.params;
    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'You cannot add yourself' });
    }
    const peer = await fastify.repos.users.getUserById(userId);
    if (!peer) return reply.code(404).send({ error: 'User not found' });

    await fastify.repos.phase8.addContact(request.user.id, userId, request.body || {});
    return reply.code(201).send({ added: userId });
  });

  fastify.delete('/api/contacts/:userId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: chatParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.phase8.removeContact(request.user.id, request.params.userId);
    return reply.send({ removed: request.params.userId });
  });

  fastify.get('/api/contacts', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({
    contacts: await fastify.repos.phase8.listContacts(request.user.id),
  }));

  // ═══════════════════════════════════════════════════════════
  // Stories
  // ═══════════════════════════════════════════════════════════

  fastify.post('/api/stories', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['media'],
        properties: {
          media:   { type: 'object', additionalProperties: true },
          caption: { type: ['string', 'null'], maxLength: MAX_CAPTION },
          privacy: { type: 'string', enum: ['everyone', 'contacts', 'nobody'], default: 'contacts' },
        },
      },
    },
  }, async (request, reply) => {
    const story = await fastify.repos.phase8.createStory(request.user.id, request.body);
    return reply.code(201).send(story);
  });

  fastify.get('/api/stories', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({
    // Privacy and blocking are applied in the query, not filtered afterwards:
    // a fetch-then-filter version leaks through any path that forgets the
    // filter.
    stories: await fastify.repos.phase8.feedFor(request.user.id),
  }));

  fastify.get('/api/stories/mine', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({
    stories: await fastify.repos.phase8.storiesFor(request.user.id),
  }));

  fastify.post('/api/stories/:storyId/view', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['storyId'], properties: { storyId: chatParam } },
    },
  }, async (request, reply) => {
    const { storyId } = request.params;

    // Checked against the same visibility rules as the feed: recording a view
    // for a story the caller may not see would both leak its existence and
    // put their name in someone else's viewer list.
    const visible = await fastify.repos.phase8.feedFor(request.user.id);
    if (!visible.some((s) => s.id === storyId)) {
      return reply.code(404).send({ error: 'Story not found' });
    }

    await fastify.repos.phase8.recordStoryView(storyId, request.user.id);
    return reply.send({ ok: true });
  });

  fastify.get('/api/stories/:storyId/viewers', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['storyId'], properties: { storyId: chatParam } },
    },
  }, async (request, reply) => {
    // Scoped to the author inside the query. Who looked at your story is
    // yours; who looked at someone else's is not.
    const viewers = await fastify.repos.phase8.storyViewers(
      request.params.storyId, request.user.id
    );
    return reply.send({ viewers });
  });

  fastify.delete('/api/stories/:storyId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['storyId'], properties: { storyId: chatParam } },
    },
  }, async (request, reply) => {
    const deleted = await fastify.repos.phase8.deleteStory(
      request.user.id, request.params.storyId
    );
    if (!deleted) return reply.code(404).send({ error: 'Story not found' });
    return reply.send({ deleted: request.params.storyId });
  });
}

export default phase8Routes;
