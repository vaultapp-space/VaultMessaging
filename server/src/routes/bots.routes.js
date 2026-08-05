// ============================================================
// Vault — Bot management (the BotFather equivalent)
// ============================================================
// The *user-facing* half of the bot platform: creating a bot, rotating its
// token, adding it to a chat, and pressing its buttons. Bots themselves talk
// to `/bot<token>/…` in bot-api.routes.js.
//
// The split matters. These routes authenticate with a session cookie and act
// on behalf of a person; those authenticate with a bearer token and act on
// behalf of a bot. Merging them would mean every handler in the product had
// to reason about which kind of caller it had, and getting that wrong once
// means a token acting as a user.

import { UUID_PATTERN } from '../utils/constants.js';

const chatParam = { type: 'string', pattern: UUID_PATTERN };

async function botRoutes(fastify) {

  // ─── CREATE ───────────────────────────────────────────────
  fastify.post('/api/bots', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          // Ends in `bot` by convention, and enforced: a user must be able to
          // tell from a name alone whether they are talking to a person.
          username:    { type: 'string', minLength: 5, maxLength: 32, pattern: '^[a-zA-Z0-9_]+$' },
          description: { type: ['string', 'null'], maxLength: 512 },
        },
      },
    },
  }, async (request, reply) => {
    const { username } = request.body;
    if (!/bot$/i.test(username)) {
      return reply.code(400).send({ error: 'A bot username must end in "bot"' });
    }

    const result = await fastify.repos.bots.create(request.user.id, request.body);
    if (!result.ok) return reply.code(409).send({ error: result.reason });

    // The token is returned exactly once. It is stored only as a hash, so
    // there is no way to show it again — the client must surface it now.
    return reply.code(201).send({ ...result.bot, token: result.token });
  });

  // ─── LIST mine ────────────────────────────────────────────
  fastify.get('/api/bots', {
    preValidation: [fastify.authenticate],
  }, async (request) => ({
    bots: await fastify.repos.bots.listForOwner(request.user.id),
  }));

  // ─── DIRECTORY ────────────────────────────────────────────
  fastify.get('/api/bots/search', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object', required: ['q'],
        properties: { q: { type: 'string', minLength: 1, maxLength: 64 } },
      },
    },
  }, async (request) => ({
    bots: await fastify.repos.bots.search(request.query.q),
  }));

  // ─── SETTINGS ─────────────────────────────────────────────
  fastify.patch('/api/bots/:botId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['botId'], properties: { botId: chatParam } },
      body: {
        type: 'object',
        properties: {
          description: { type: ['string', 'null'], maxLength: 512 },
          about:       { type: ['string', 'null'], maxLength: 512 },
          canJoinGroups: { type: ['boolean', 'null'] },
          // Turning this on means the bot sees every message in every group
          // it is in. Off by default, and the client says so plainly.
          canReadAllGroupMessages: { type: ['boolean', 'null'] },
          supportsInline: { type: ['boolean', 'null'] },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await fastify.repos.bots.get(request.params.botId);
    if (!bot || bot.ownerId !== request.user.id) {
      return reply.code(404).send({ error: 'Bot not found' });
    }
    return reply.send(await fastify.repos.bots.updateSettings(bot.id, request.body));
  });

  // ─── ROTATE TOKEN ─────────────────────────────────────────
  fastify.post('/api/bots/:botId/token', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['botId'], properties: { botId: chatParam } },
    },
  }, async (request, reply) => {
    const bot = await fastify.repos.bots.get(request.params.botId);
    if (!bot || bot.ownerId !== request.user.id) {
      return reply.code(404).send({ error: 'Bot not found' });
    }
    // Takes effect immediately: this is the only remedy for a leaked token,
    // so letting the old one drain would defeat the point.
    const token = await fastify.repos.bots.rotateToken(bot.id);
    return reply.send({ token });
  });

  // ─── DELETE ───────────────────────────────────────────────
  fastify.delete('/api/bots/:botId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['botId'], properties: { botId: chatParam } },
    },
  }, async (request, reply) => {
    const deleted = await fastify.repos.bots.delete(request.user.id, request.params.botId);
    if (!deleted) return reply.code(404).send({ error: 'Bot not found' });
    return reply.send({ deleted: request.params.botId });
  });

  // ─── ADD a bot to a chat ──────────────────────────────────
  fastify.post('/api/chats/:chatId/bots', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['chatId'], properties: { chatId: chatParam } },
      body: {
        type: 'object', required: ['botId'],
        properties: { botId: chatParam },
      },
    },
  }, async (request, reply) => {
    const { chatId } = request.params;
    const bot = await fastify.repos.bots.get(request.body.botId);
    if (!bot) return reply.code(404).send({ error: 'Bot not found' });

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    // The refusal that keeps the encryption claim honest. A bot in a secret
    // chat would mean the server reading a conversation the user believes it
    // cannot — so this is a hard error, not a downgrade.
    if (chat.mode !== 'cloud') {
      return reply.code(400).send({
        error: 'Bots cannot be added to end-to-end encrypted chats',
      });
    }

    const rights = await fastify.repos.phase3.rightsFor(chatId, request.user.id);
    if (!rights?.has('invite')) {
      return reply.code(403).send({ error: 'You cannot add members to this chat' });
    }
    if (chat.type === 'group' && !bot.canJoinGroups) {
      return reply.code(403).send({ error: 'That bot cannot be added to groups' });
    }

    await fastify.repos.chats.addMember(chatId, bot.id);
    return reply.code(201).send({ botId: bot.id, username: bot.username });
  });

  // ─── PRESS an inline keyboard button ──────────────────────
  //
  // The button's existence is checked against the *stored* markup rather than
  // trusted from the request. Without that, anyone could send a chosen
  // callback payload to any bot and make it act on data it never offered.
  fastify.post('/api/chats/:chatId/messages/:seq/callback', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['chatId', 'seq'],
        properties: { chatId: chatParam, seq: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object', required: ['data'],
        properties: { data: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const { chatId, seq } = request.params;
    if (!(await fastify.repos.chats.isMember(chatId, request.user.id))) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const message = await fastify.repos.messages.getBySeq(chatId, seq);
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    const markup = await fastify.repos.messages.getReplyMarkup(chatId, seq);
    const buttons = (markup?.inline_keyboard ?? []).flat();
    if (!buttons.some((b) => b.callback_data === request.body.data)) {
      return reply.code(400).send({ error: 'That button is not on this message' });
    }

    const botId = message.sender_id;
    const bot = await fastify.repos.bots.get(botId);
    if (!bot) return reply.code(400).send({ error: 'That message is not from a bot' });

    const queryId = await fastify.repos.bots.createCallbackQuery({
      botId, userId: request.user.id, chatId, messageSeq: Number(seq),
      data: request.body.data,
    });

    await fastify.repos.bots.enqueue(botId, 'callback_query', {
      callback_query: {
        id: queryId,
        from: { id: request.user.id, username: request.user.username },
        chat_id: chatId,
        message_id: Number(seq),
        data: request.body.data,
      },
    });

    return reply.send({ queryId });
  });

  // ─── INLINE QUERY ─────────────────────────────────────────
  fastify.post('/api/bots/:botId/inline', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['botId'], properties: { botId: chatParam } },
      body: {
        type: 'object', required: ['query'],
        properties: { query: { type: 'string', maxLength: 256 } },
      },
    },
  }, async (request, reply) => {
    const bot = await fastify.repos.bots.get(request.params.botId);
    if (!bot) return reply.code(404).send({ error: 'Bot not found' });
    if (!bot.supportsInline) {
      return reply.code(400).send({ error: 'That bot does not support inline queries' });
    }

    const queryId = await fastify.repos.bots.createInlineQuery({
      botId: bot.id, userId: request.user.id, query: request.body.query,
    });

    await fastify.repos.bots.enqueue(bot.id, 'inline_query', {
      inline_query: {
        id: queryId,
        from: { id: request.user.id, username: request.user.username },
        query: request.body.query,
      },
    });

    return reply.send({ queryId });
  });

  fastify.get('/api/bots/inline/:queryId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['queryId'], properties: { queryId: chatParam } },
    },
  }, async (request, reply) => {
    const results = await fastify.repos.bots.getInlineResults(request.params.queryId);
    return reply.send({ results: results ?? null });
  });

  // ─── DEEP LINK start parameter ────────────────────────────
  //
  // `/start <payload>` opens a chat with the bot and hands it the payload —
  // how a bot is linked to from outside the app. The payload is opaque to us
  // and is passed through as text, never interpreted.
  fastify.post('/api/bots/:botId/start', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['botId'], properties: { botId: chatParam } },
      body: {
        type: 'object',
        properties: { payload: { type: ['string', 'null'], maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const bot = await fastify.repos.bots.get(request.params.botId);
    if (!bot) return reply.code(404).send({ error: 'Bot not found' });

    const chatId = await fastify.repos.chats.ensurePrivateChat(
      request.user.id, bot.id, { mode: 'cloud' }
    );
    const chat = await fastify.repos.chats.get(chatId);

    const text = request.body?.payload ? `/start ${request.body.payload}` : '/start';
    const stored = await fastify.repos.messages.createCloudMessage({
      chatId: chat.id, senderId: request.user.id, type: 'text', body: text,
      ttlSeconds: fastify.repos.chats.resolveTtlSeconds({}),
    });

    await fastify.repos.bots.enqueue(bot.id, 'message', {
      message: {
        message_id: Number(stored.seq),
        chat_id: chat.id,
        from: { id: request.user.id, username: request.user.username },
        text,
        date: stored.sent_at,
      },
    });

    return reply.code(201).send({ chatId: chat.id, seq: Number(stored.seq) });
  });

  // ─── WEBHOOK WORKER ───────────────────────────────────────
  //
  // Drains the queue for bots that registered a webhook. Runs in-process on
  // an interval rather than as a separate service: at this scale a worker
  // process is more moving parts than it is worth, and the retry state lives
  // in the database either way so it survives a restart.
  const webhookTimer = setInterval(async () => {
    try {
      const pending = await fastify.repos.bots.pendingForWebhook(50);
      for (const item of pending) {
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (item.secret) headers['X-Telegram-Bot-Api-Secret-Token'] = item.secret;

          // A hard timeout, because a bot's endpoint is a third-party server
          // and a slow one must not stall the queue for every other bot.
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const res = await fetch(item.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ update_id: item.id, ...item.payload }),
            signal: controller.signal,
            redirect: 'error',
          });
          clearTimeout(timeout);

          if (res.ok) {
            await fastify.repos.bots.markDelivered(item.id);
          } else {
            await fastify.repos.bots.markFailed(item.id, item.attempts);
          }
        } catch {
          // Backs off exponentially. A bot whose endpoint is down must not
          // become an unbounded retry loop against someone else's server.
          await fastify.repos.bots.markFailed(item.id, item.attempts);
        }
      }
    } catch (err) {
      fastify.log.warn({ err }, 'bot webhook worker pass failed');
    }
  }, 2000);

  fastify.addHook('onClose', async () => {
    clearInterval(webhookTimer);
  });
}

export default botRoutes;
