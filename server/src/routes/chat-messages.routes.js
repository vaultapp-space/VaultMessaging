// ============================================================
// Vault — Cloud Chat Messages
// ============================================================
// The cloud half of the dual-mode fork.
//
// A cloud message is stored as columns — `body`, `entities`, `media` — in
// plaintext, which is what lets the server search it, unfurl its links, and
// replay it to a device that holds no keys. A secret message continues to
// travel through POST /api/messages as ciphertext the server cannot read.
// Both write the same `messages` row and both leave through the same fanout,
// so the client sees one shape either way.
//
// Two things are enforced here rather than trusted from the client:
//
//   - Cloud storage is refused for a secret chat. A client bug that posted
//     here for a secret conversation would silently hand the server plaintext
//     for a conversation the user believes is end-to-end encrypted. That is
//     the worst failure this codebase could have, so it is a hard 400.
//
//   - The 24h ceiling. `resolveTtlSeconds` clamps whatever is requested, so
//     no client — modified or not — can make a message outlive the rule.

import { UUID_PATTERN } from '../utils/constants.js';
import { capabilities } from '../../../shared/capabilities.js';
import { MAX_TTL_SECONDS } from '../repos/chats.repo.js';
import { extractFirstUrl, fetchPreview } from '../lib/link-preview.js';

const MAX_BODY_LENGTH = 8192;

async function chatMessageRoutes(fastify) {

  /**
   * Queues a message for every bot in the chat that is entitled to see it.
   *
   * "Entitled" is the whole point. In a private chat with a bot, the bot sees
   * everything — that is what the chat is for. In a group, privacy mode is on
   * by default and the bot sees only messages that address it: a command, or
   * a reply to one of its own messages. Putting this filter in the delivery
   * path rather than in the bot client means a bot author cannot opt out of
   * it, and a user's expectation that adding a bot does not hand it the
   * transcript actually holds.
   */
  async function deliverToBots({ chat, chatId, senderId, senderUsername, seq,
    body, sentAt, memberIds, ttl }) {
    // A secret chat never reaches here — the route refuses cloud sends for one
    // — but the guard is restated because this function queues plaintext.
    if (chat.mode !== 'cloud') return;

    for (const memberId of memberIds) {
      if (memberId === senderId) continue;
      const bot = await fastify.repos.bots.get(memberId);
      if (!bot) continue;

      if (chat.type !== 'private' && !bot.canReadAllGroupMessages) {
        const addressed = typeof body === 'string' && (
          body.startsWith('/')
          || body.includes(`@${bot.username}`)
        );
        if (!addressed) continue;
      }

      await fastify.repos.bots.enqueue(bot.id, 'message', {
        message: {
          message_id: seq,
          chat_id: chatId,
          chat_type: chat.type,
          from: { id: senderId, username: senderUsername },
          text: body,
          date: sentAt,
        },
      }, { ttlSeconds: ttl });
    }
  }

  // Fetches a link preview and pushes it to the chat once available.
  // Failures are swallowed: a preview is a nicety and must never surface to
  // the user as an error on a message that sent perfectly well.
  async function unfurlInBackground({ chatId, seq, body, memberIds }) {
    try {
      const url = extractFirstUrl(body);
      if (!url) return;

      const cached = await fastify.repos.phase2.getCachedPreview(url);
      if (cached?.failed) return;

      let preview = cached;
      if (!preview) {
        preview = await fetchPreview(url);
        // Cached either way — a failure is recorded so one dead link in a busy
        // chat does not become a steady stream of outbound requests.
        await fastify.repos.phase2.cachePreview(url, preview);
        if (!preview) return;
      }

      await fastify.repos.phase2.attachPreview(chatId, seq, preview);
      await fastify.fanout.deliverToUsers(memberIds, {
        type: 'message_preview', chatId, seq, preview,
      });
    } catch (err) {
      fastify.log.warn({ err, chatId, seq }, 'link preview failed');
    }
  }


  // ─── SEND to a cloud chat ─────────────────────────────────
  fastify.post('/api/chats/:chatId/messages', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: { chatId: { type: 'string', pattern: UUID_PATTERN } },
      },
      body: {
        type: 'object',
        properties: {
          type:     { type: 'string', default: 'text' },
          body:     { type: ['string', 'null'], maxLength: MAX_BODY_LENGTH },
          entities: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
          media:    { type: ['object', 'null'], additionalProperties: true },
          replyToSeq: { type: ['integer', 'null'], minimum: 1 },
          groupedId:  { type: ['string', 'null'] },
          ttlSeconds: { type: ['integer', 'null'], minimum: 1 },
          // Lets a retried send resolve to the same message instead of a
          // duplicate; the unique index on (sender_id, client_random_id)
          // is what actually enforces it.
          clientRandomId: { type: ['integer', 'null'] },
          // Cleared server-side once every other member has opened it.
          viewOnce: { type: ['boolean', 'null'] },
          // Forum groups only. Tags the message with the topic it belongs to,
          // which is what keeps topics separate conversations rather than one
          // interleaved stream.
          topicId: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const senderId = request.user.id;
    const {
      type = 'text', body = null, entities = null, media = null,
      replyToSeq = null, groupedId = null, ttlSeconds = null, clientRandomId = null,
      viewOnce = false, topicId = null,
    } = request.body || {};

    if (!(await fastify.repos.chats.isMember(chatId, senderId))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    if (!capabilities(chat).isCloud) {
      return reply.code(400).send({
        error: 'This chat is end-to-end encrypted; send through /api/messages instead',
      });
    }

    if (body === null && media === null) {
      return reply.code(400).send({ error: 'A message needs a body or media' });
    }

    // A private chat between two people who have blocked each other must not
    // carry messages. Groups are left alone: blocking someone should not
    // remove your ability to speak in a room you both happen to be in.
    if (chat.type === 'private') {
      const others = (await fastify.repos.chats.memberIds(chatId))
        .filter((id) => id !== senderId);
      for (const other of others) {
        if (await fastify.repos.phase2.isBlockedBetween(senderId, other)) {
          return reply.code(403).send({ error: 'Message could not be delivered' });
        }
      }
    }

    const ttl = fastify.repos.chats.resolveTtlSeconds({
      requestedSeconds: ttlSeconds,
      chatDefaultSeconds: chat.defaultTtlSecs,
    });

    const stored = await fastify.repos.messages.createCloudMessage({
      chatId, senderId, type, body, entities, media,
      replyToSeq, groupedId, ttlSeconds: ttl, clientRandomId,
      viewOnce: Boolean(viewOnce), topicId,
    });

    // The first message in a topic becomes its root, so a deep link into the
    // topic has something to point at.
    if (topicId) {
      await fastify.repos.phase8.setTopicRoot(chatId, topicId, Number(stored.seq));
    }

    const payload = {
      type: 'message',
      data: {
        id: stored.id,
        chatId,
        seq: Number(stored.seq),
        senderId,
        senderUsername: request.user.username,
        messageType: type,
        body, entities, media,
        replyToSeq,
        groupedId,
        // Echoed back so the sender can match this against the copy it
        // already put in its own list, instead of rendering it twice while
        // the HTTP response is still in flight.
        clientRandomId,
        viewOnce: Boolean(viewOnce),
        topicId,
        sentAt: stored.sent_at,
        expiresAt: stored.expires_at,
        mode: 'cloud',
      },
    };

    // Everyone in the chat, including the sender's other devices — which is
    // the multi-device sync that cloud mode exists to provide.
    const memberIds = await fastify.repos.chats.memberIds(chatId);

    // Recorded before delivery, not after. A device that is offline right now
    // finds this on its next catch-up; one that is connected gets it over the
    // socket. Appending after the fanout would leave a window where a message
    // was delivered live but never written to the log, so a device that
    // reconnected in that window would miss it permanently.
    //
    // Secret chats are excluded: the payload here is plaintext, and writing
    // one to the log would hand the server the very content the mode exists
    // to keep from it.
    for (const memberId of memberIds) {
      await fastify.repos.devices.append(memberId, 'message', payload.data, {
        ttlSeconds: ttl,
      });
    }

    await fastify.fanout.deliverToUsers(memberIds, payload);

    // Feed any bots in this chat. The privacy filter lives here rather than
    // in the bot's client, so a bot author cannot opt out of it: by default a
    // bot in a group receives only messages addressed to it.
    await deliverToBots({ chat, chatId, senderId, senderUsername: request.user.username,
      seq: Number(stored.seq), body, sentAt: stored.sent_at, memberIds, ttl });

    // Unfurl after replying, never before. Fetching a third-party URL can take
    // seconds or hang; making the send wait on it would let any slow site
    // degrade messaging. The preview arrives as its own event when ready.
    //
    // Only cloud chats reach here at all. Unfurling a secret chat's link would
    // mean the server reading content it cannot see — and would tell the
    // linked site that this URL was shared in an encrypted conversation, which
    // is a traffic-analysis leak, not just a privacy nicety.
    void unfurlInBackground({ chatId, seq: Number(stored.seq), body, memberIds });

    return reply.code(201).send(payload.data);
  });

  // ─── EDIT a cloud message ─────────────────────────────────
  //
  // No separate edit window. Telegram allows 48 hours, but every message here
  // is deleted 24 hours after it was sent, so a 48h window would be code that
  // can never run. The rule is simply: a message is editable for as long as it
  // exists. Expiry does the rest.
  fastify.patch('/api/chats/:chatId/messages/:seq', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId', 'seq'],
        properties: {
          chatId: { type: 'string', pattern: UUID_PATTERN },
          seq: { type: 'integer', minimum: 1 },
        },
      },
      body: {
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH },
          entities: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    const { body, entities = null } = request.body;

    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    if (!capabilities(chat).isCloud) {
      return reply.code(400).send({
        error: 'This chat is end-to-end encrypted; send the edit as an encrypted op',
      });
    }

    const existing = await fastify.repos.messages.getBySeq(chatId, seq);
    if (!existing) return reply.code(404).send({ error: 'Message not found' });

    // Only the author may rewrite their own words. Enforced here rather than
    // trusted from the client, and checked before the update so a non-author
    // learns nothing about whether the edit would have succeeded.
    if (existing.sender_id !== request.user.id) {
      return reply.code(403).send({ error: 'Only the sender can edit a message' });
    }

    const updated = await fastify.repos.messages.editCloudMessage(
      chatId, seq, request.user.id, { body, entities }
    );
    if (!updated) return reply.code(404).send({ error: 'Message not found' });

    const payload = {
      type: 'message_edited',
      chatId,
      seq: Number(updated.seq),
      body: updated.body,
      entities: updated.entities,
      editedAt: updated.edited_at,
    };

    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, payload);

    return reply.send(payload);
  });

  // ─── FETCH a cloud chat's messages ────────────────────────
  fastify.get('/api/chats/:chatId/messages', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['chatId'],
        properties: { chatId: { type: 'string', pattern: UUID_PATTERN } },
      },
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          before: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const { limit = 50, before, topicId = null } = request.query;

    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    // topicId narrows a forum group to one topic. Omitted, it returns the
    // whole chat, which is what every non-forum caller wants.
    const messages = await fastify.repos.messages.getChatMessages(chatId, {
      limit, before, topicId,
    });

    // Poll results are per-viewer (which option is *mine*) and live, so they
    // cannot be denormalized onto the message row the way reactions are. The
    // loop is over poll messages only, which in practice is nearly always
    // none — a plain history fetch issues no extra queries at all.
    for (const message of messages) {
      if (message.messageType !== 'poll') continue;
      const pollId = await fastify.repos.phase3.getPollForMessage(chatId, message.seq);
      if (pollId) {
        message.poll = await fastify.repos.phase3.getPollResults(pollId, request.user.id);
      }
    }

    return {
      messages,
      hasMore: messages.length === limit,
      // Stated explicitly so a client never has to infer why history stops.
      retentionSeconds: MAX_TTL_SECONDS,
    };
  });
}

export default chatMessageRoutes;
