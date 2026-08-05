// ============================================================
// Vault — Channels
// ============================================================
// Broadcast chats. Admins post; everyone else subscribes and reads.
//
// The fanout rule from Phase 0.5 is enforced here and is the reason this file
// does not simply reuse the group send path: a channel post writes **one**
// row and publishes **once**. It does not append a `user_updates` row per
// subscriber, and it does not iterate the subscriber list to deliver. For a
// channel with a million subscribers, either would turn one post into a
// million writes.
//
// Connected subscribers get the post over their socket. Everyone else finds
// it from `chats.last_message_at` and pulls when they open the channel. That
// asymmetry is deliberate and is what makes the O(1) write possible.
//
// One thing users will find surprising, and the UI has to say out loud:
// **posts expire after 24 hours like everything else.** A channel is exactly
// the thing people expect to be an archive, so a quiet channel opening empty
// reads as data loss unless it is explained.

import { UUID_PATTERN } from '../utils/constants.js';
import { MAX_TTL_SECONDS } from '../repos/chats.repo.js';

const MAX_BODY_LENGTH = 8192;
const chatParam = { type: 'string', pattern: UUID_PATTERN };

async function channelRoutes(fastify) {

  // Resolves what the caller may do in a channel. Admin rights come from the
  // Phase 3 rights model, which channels reuse rather than reinvent.
  async function requireAdmin(request, reply, chatId, right) {
    const channel = await fastify.repos.channels.get(chatId);
    if (!channel) {
      reply.code(404).send({ error: 'Channel not found' });
      return null;
    }
    // `rightsFor` returns null for a non-member and a Set otherwise.
    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    if (!rights || !rights.has(right)) {
      // 404 rather than 403 for a non-member: whether a private channel
      // exists at all is itself information. A subscriber is *not* a member
      // here — admins and subscribers are deliberately different tables — so
      // a subscriber without rights also gets 404.
      reply.code(rights ? 403 : 404).send({
        error: rights ? 'You do not have permission to do that' : 'Channel not found',
      });
      return null;
    }
    return channel;
  }

  // ─── CREATE ───────────────────────────────────────────────
  fastify.post('/api/channels', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:    { type: 'string', minLength: 1, maxLength: 128 },
          about:    { type: ['string', 'null'], maxLength: 512 },
          // A public username makes the channel readable by anyone. Omitting
          // it keeps the channel private, reachable only by invite.
          username: { type: ['string', 'null'], minLength: 5, maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const result = await fastify.repos.channels.create(request.user.id, request.body);
    if (!result.ok) return reply.code(409).send({ error: result.reason });

    await fastify.repos.channels.logAction(
      result.channel.id, request.user.id, 'channel_created'
    );
    return reply.code(201).send(result.channel);
  });

  // ─── LIST mine ────────────────────────────────────────────
  fastify.get('/api/channels', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({
    channels: await fastify.repos.channels.listForUser(request.user.id),
  }));

  // ─── DIRECTORY ────────────────────────────────────────────
  fastify.get('/api/channels/search', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object', required: ['q'],
        properties: { q: { type: 'string', minLength: 1, maxLength: 64 } },
      },
    },
  }, async (request) => ({
    channels: await fastify.repos.channels.search(request.query.q),
  }));

  // ─── RESOLVE a public username ────────────────────────────
  fastify.get('/api/channels/by-username/:username', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['username'],
        properties: { username: { type: 'string', maxLength: 32 } },
      },
    },
  }, async (request, reply) => {
    const channel = await fastify.repos.channels.getByUsername(request.params.username);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    return reply.send(channel);
  });

  // ─── GET one ──────────────────────────────────────────────
  fastify.get('/api/channels/:chatId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await fastify.repos.channels.canRead(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    const channel = await fastify.repos.channels.get(chatId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    return reply.send({
      ...channel,
      subscribed: await fastify.repos.channels.isSubscribed(chatId, request.user.id),
      canPost: Boolean(rights?.has('post')),
      rights: rights ? [...rights] : [],
    });
  });

  // ─── SUBSCRIBE / UNSUBSCRIBE ──────────────────────────────
  fastify.post('/api/channels/:chatId/subscribe', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const channel = await fastify.repos.channels.get(chatId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });

    // A private channel is joined through an invite link, not by knowing its
    // id. Allowing this would make the id itself a bearer credential.
    if (!channel.username) {
      return reply.code(403).send({ error: 'This channel is invite-only' });
    }
    // A banned user must not be able to walk straight back in.
    if (await fastify.repos.phase3.isBanned(chatId, request.user.id)) {
      return reply.code(403).send({ error: 'You cannot join this channel' });
    }

    await fastify.repos.channels.subscribe(chatId, request.user.id);
    return reply.send({ subscribed: true });
  });

  fastify.delete('/api/channels/:chatId/subscribe', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.channels.unsubscribe(request.params.chatId, request.user.id);
    return reply.send({ subscribed: false });
  });

  // ─── POST to a channel ────────────────────────────────────
  fastify.post('/api/channels/:chatId/posts', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        properties: {
          body:       { type: ['string', 'null'], maxLength: MAX_BODY_LENGTH },
          entities:   { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
          media:      { type: ['object', 'null'], additionalProperties: true },
          type:       { type: 'string', default: 'text' },
          clientRandomId: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const channel = await requireAdmin(request, reply, chatId, 'post');
    if (!channel) return undefined;

    const { body = null, entities = null, media = null, type = 'text',
      clientRandomId = null } = request.body || {};
    if (body === null && media === null) {
      return reply.code(400).send({ error: 'A post needs a body or media' });
    }

    const stored = await fastify.repos.messages.createCloudMessage({
      chatId, senderId: request.user.id, type, body, entities, media,
      clientRandomId,
      ttlSeconds: fastify.repos.chats.resolveTtlSeconds({}),
    });

    // Signed posts carry the admin's name; unsigned ones are attributed to
    // the channel. The author is stored either way so the admin log can
    // answer "who posted this" without the feed revealing it.
    if (channel.signaturesEnabled) {
      await fastify.repos.messages.setPostAuthor(
        chatId, Number(stored.seq), request.user.username
      );
    }

    const payload = {
      type: 'channel_post',
      data: {
        id: stored.id,
        chatId,
        seq: Number(stored.seq),
        channelTitle: channel.title,
        postAuthor: channel.signaturesEnabled ? request.user.username : null,
        messageType: type,
        body, entities, media,
        clientRandomId,
        sentAt: stored.sent_at,
        expiresAt: stored.expires_at,
        mode: 'cloud',
      },
    };

    // O(1). Published once to everyone currently watching this channel;
    // subscribers who are offline pull it on open rather than each getting a
    // row written for them. Writing per-subscriber here is the mistake that
    // makes one post cost a million inserts.
    await fastify.fanout.deliverToChannel(chatId, payload);

    return reply.code(201).send(payload.data);
  });

  // ─── READ a channel's posts ───────────────────────────────
  fastify.get('/api/channels/:chatId/posts', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          before: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await fastify.repos.channels.canRead(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Channel not found' });
    }

    const { limit, before } = request.query;
    const posts = await fastify.repos.messages.getChatMessages(chatId, { limit, before });

    // Comment counts come from the counter table rather than a COUNT(*) per
    // post: this renders on every post in the feed.
    const threads = await fastify.repos.channels.threadsFor(chatId, posts.map((p) => p.seq));

    for (const post of posts) {
      post.repliesCount = threads.get(post.seq) ?? 0;
      post.views = Math.max(
        post.views ?? 0,
        await fastify.repos.channels.viewCount(chatId, post.seq)
      );
    }

    return {
      posts,
      hasMore: posts.length === limit,
      // Said explicitly so a client never has to infer why a channel is
      // empty — the most common support question this design will generate.
      retentionSeconds: MAX_TTL_SECONDS,
    };
  });

  // ─── VIEW a post ──────────────────────────────────────────
  fastify.post('/api/channels/:chatId/posts/:seq/view', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await fastify.repos.channels.canRead(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    // Deduplicated in Redis, so refreshing does not inflate the count and a
    // hot post does not turn one row into a lock queue.
    await fastify.repos.channels.recordView(chatId, seq, request.user.id);
    return reply.send({ views: await fastify.repos.channels.viewCount(chatId, seq) });
  });

  // ─── COMMENTS ─────────────────────────────────────────────
  //
  // A comment is an ordinary message in the channel's linked discussion
  // group. The channel itself stays broadcast-only, which is what keeps the
  // fanout rule intact: comments fan out to a group's members, not to a
  // channel's subscribers.
  fastify.post('/api/channels/:chatId/posts/:seq/comments', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object', required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    const channel = await fastify.repos.channels.get(chatId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!(await fastify.repos.channels.canRead(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    if (!channel.linkedChatId) {
      return reply.code(400).send({ error: 'This channel has comments disabled' });
    }
    // A ban can be recorded against either chat id: the channel itself
    // (banned via the channel's own admin surface) or the linked discussion
    // group (banned via its Members panel — the generic
    // `POST /api/chats/:chatId/members/:userId/ban` route, pointed at the
    // group, which is the path the UI actually offers for removing a
    // disruptive commenter). `addMember` below re-joins the commenter to the
    // group, so missing either check would let a banned user walk straight
    // back in on their next comment.
    const bannedFromChannel = await fastify.repos.phase3.isBanned(chatId, request.user.id);
    const bannedFromGroup = await fastify.repos.phase3.isBanned(channel.linkedChatId, request.user.id);
    if (bannedFromChannel || bannedFromGroup) {
      return reply.code(403).send({ error: 'You cannot comment on this channel' });
    }

    // Commenting joins the discussion group, which is what makes replies
    // reach the other commenters.
    await fastify.repos.chats.addMember(channel.linkedChatId, request.user.id);

    const stored = await fastify.repos.messages.createCloudMessage({
      chatId: channel.linkedChatId,
      senderId: request.user.id,
      type: 'text',
      body: request.body.body,
      threadRootSeq: Number(seq),
      ttlSeconds: fastify.repos.chats.resolveTtlSeconds({}),
    });

    const thread = await fastify.repos.channels.addThreadReply(
      chatId, Number(seq), Number(stored.seq)
    );

    const memberIds = await fastify.repos.chats.memberIds(channel.linkedChatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'message',
      data: {
        id: stored.id,
        chatId: channel.linkedChatId,
        seq: Number(stored.seq),
        senderId: request.user.id,
        senderUsername: request.user.username,
        messageType: 'text',
        body: request.body.body,
        threadRootSeq: Number(seq),
        sentAt: stored.sent_at,
        expiresAt: stored.expires_at,
        mode: 'cloud',
      },
    });

    // Everyone reading the channel sees the comment count move.
    await fastify.fanout.deliverToChannel(chatId, {
      type: 'thread_updated', chatId, seq: Number(seq),
      repliesCount: thread.repliesCount,
    });

    return reply.code(201).send({ seq: Number(stored.seq), ...thread });
  });

  fastify.get('/api/channels/:chatId/posts/:seq/comments', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    const channel = await fastify.repos.channels.get(chatId);
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    if (!(await fastify.repos.channels.canRead(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Channel not found' });
    }
    if (!channel.linkedChatId) return reply.send({ comments: [] });

    const comments = await fastify.repos.messages.getThreadMessages(
      channel.linkedChatId, Number(seq)
    );
    return reply.send({ comments });
  });

  // ─── LINK a discussion group ──────────────────────────────
  fastify.post('/api/channels/:chatId/discussion', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object', required: ['groupId'],
        properties: { groupId: chatParam },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireAdmin(request, reply, chatId, 'changeInfo'))) return undefined;

    // Linking a group you do not run would let anyone attach their channel's
    // comment section to someone else's conversation.
    const groupRights = await fastify.repos.phase3.rightsFor(
      request.body.groupId, request.user.id
    );
    if (!groupRights?.has('changeInfo')) {
      return reply.code(403).send({ error: 'You do not administer that group' });
    }

    await fastify.repos.channels.linkDiscussion(chatId, request.body.groupId);
    await fastify.repos.channels.logAction(chatId, request.user.id, 'discussion_linked', {
      details: { groupId: request.body.groupId },
    });
    return reply.send({ linkedChatId: request.body.groupId });
  });

  // ─── SIGNED POSTS ─────────────────────────────────────────
  fastify.patch('/api/channels/:chatId/settings', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object',
        properties: { signaturesEnabled: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    if (!(await requireAdmin(request, reply, chatId, 'changeInfo'))) return undefined;

    if (typeof request.body.signaturesEnabled === 'boolean') {
      await fastify.repos.channels.setSignatures(chatId, request.body.signaturesEnabled);
      await fastify.repos.channels.logAction(
        chatId, request.user.id,
        request.body.signaturesEnabled ? 'signatures_on' : 'signatures_off'
      );
    }
    return reply.send(await fastify.repos.channels.get(chatId));
  });

  // ─── ADMIN LOG ────────────────────────────────────────────
  fastify.get('/api/channels/:chatId/admin-log', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    // Readable by anyone who can moderate — an audit log visible to
    // subscribers would expose which admin took which action.
    if (!(await requireAdmin(request, reply, chatId, 'ban'))) return undefined;
    return reply.send({ entries: await fastify.repos.channels.adminLog(chatId) });
  });
}

export default channelRoutes;
