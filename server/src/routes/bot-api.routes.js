// ============================================================
// Vault — Bot API
// ============================================================
// The surface bots talk to: `/bot<token>/<method>`, Telegram's shape.
//
// This is a **separate authentication surface** from the rest of the product,
// and keeping it separate is the point. Bots authenticate with a bearer token
// in the path; users authenticate with a session cookie. Sharing one
// `authenticate` between them would mean every route in the codebase had to
// reason about which kind of caller it had — and getting that wrong once
// means a bot token acting as a user, or a user acting as a bot.
//
// Consequences enforced here rather than assumed:
//
//   - **A bot cannot read a secret chat.** A bot receiving a message means the
//     server can read it. Rather than silently downgrading a conversation, a
//     send to a secret chat is refused outright.
//
//   - **A bot only sees what it is entitled to.** In a group, privacy mode
//     (the default) means it receives only commands and replies addressed to
//     it. The filter lives in the delivery path, not in the bot's client, so
//     it is not something a bot author can opt out of.
//
//   - **Everything a bot queues expires.** The queue holds message content,
//     so it is reaped on the same 24-hour schedule as messages.

import { UUID_PATTERN } from '../utils/constants.js';

const MAX_BODY_LENGTH = 8192;

// The path carries the token, so it must never reach a log line. Fastify logs
// request URLs by default, which would write every bot's credentials to disk.
function redactToken(url) {
  return url.replace(/\/bot[^/]+\//, '/bot<redacted>/');
}

async function botApiRoutes(fastify) {

  // Resolves the bot from the token in the path. Returns null and replies on
  // failure so handlers can early-return.
  async function authenticateBot(request, reply) {
    const bot = await fastify.repos.bots.authenticate(request.params.token);
    if (!bot) {
      reply.code(401).send({ ok: false, error_code: 401, description: 'Unauthorized' });
      return null;
    }
    return bot;
  }

  // Bot API replies are `{ok, result}` / `{ok, description}`, not this
  // codebase's usual shape. Matching Telegram matters here: the whole value
  // of the surface is that existing bot libraries work against it.
  function ok(reply, result) {
    return reply.send({ ok: true, result });
  }

  function fail(reply, code, description) {
    return reply.code(code).send({ ok: false, error_code: code, description });
  }

  // Every route below shares this prefix.
  const tokenParam = {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', minLength: 16, maxLength: 128 } },
  };

  fastify.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/bot')) {
      // Rewrites what Fastify logs for this request. Without it the access
      // log becomes a list of working bot credentials.
      request.log = request.log.child({ url: redactToken(request.url) });
    }
  });

  // ─── getMe ────────────────────────────────────────────────
  fastify.post('/bot:token/getMe', {
    schema: { params: tokenParam },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;
    return ok(reply, {
      id: bot.id,
      is_bot: true,
      username: bot.username,
      can_join_groups: bot.canJoinGroups,
      can_read_all_group_messages: bot.canReadAllGroupMessages,
      supports_inline_queries: bot.supportsInline,
    });
  });

  // ─── getUpdates (long-poll) ───────────────────────────────
  //
  // `offset` doubles as the acknowledgement: asking for a later offset
  // confirms everything before it, which is why there is no separate ack.
  fastify.post('/bot:token/getUpdates', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        properties: {
          offset:  { type: 'integer', minimum: 0, default: 0 },
          limit:   { type: 'integer', minimum: 1, maximum: 100, default: 100 },
          // Seconds to hold the request open when there is nothing yet.
          // Capped: an unbounded long-poll ties up a connection indefinitely.
          timeout: { type: 'integer', minimum: 0, maximum: 50, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    const { offset = 0, limit = 100, timeout = 0 } = request.body || {};

    let updates = await fastify.repos.bots.fetchUpdates(bot.id, { offset, limit });

    // Long-poll by re-checking rather than by subscribing: a bot's update
    // rate is low, and a poll loop here is far less machinery than a per-bot
    // pub/sub subscription that has to be torn down correctly on disconnect.
    const deadline = Date.now() + timeout * 1000;
    while (updates.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      updates = await fastify.repos.bots.fetchUpdates(bot.id, { offset, limit });
    }

    return ok(reply, updates);
  });

  // ─── sendMessage ──────────────────────────────────────────
  fastify.post('/bot:token/sendMessage', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['chat_id', 'text'],
        properties: {
          chat_id: { type: 'string', pattern: UUID_PATTERN },
          text:    { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH },
          reply_to_message_id: { type: ['integer', 'null'], minimum: 1 },
          // Inline keyboard. Stored on the message so a later callback can be
          // validated against the message that actually offered the button.
          reply_markup: { type: ['object', 'null'], additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    const { chat_id: chatId, text, reply_to_message_id: replyTo = null,
      reply_markup: replyMarkup = null } = request.body;

    if (!(await fastify.repos.chats.isMember(chatId, bot.id))) {
      return fail(reply, 403, 'Bot is not a member of that chat');
    }

    const chat = await fastify.repos.chats.get(chatId);
    if (!chat) return fail(reply, 400, 'Chat not found');

    // The honest refusal. A bot receiving or sending here would mean the
    // server reading a conversation the user believes is end-to-end
    // encrypted, so this is a hard error rather than a silent downgrade.
    if (chat.mode !== 'cloud') {
      return fail(reply, 400, 'Bots cannot participate in end-to-end encrypted chats');
    }

    const stored = await fastify.repos.messages.createCloudMessage({
      chatId, senderId: bot.id, type: 'text', body: text,
      replyToSeq: replyTo,
      ttlSeconds: fastify.repos.chats.resolveTtlSeconds({
        chatDefaultSeconds: chat.defaultTtlSecs,
      }),
    });

    if (replyMarkup) {
      await fastify.repos.messages.setReplyMarkup(chatId, Number(stored.seq), replyMarkup);
    }

    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'message',
      data: {
        id: stored.id, chatId, seq: Number(stored.seq),
        senderId: bot.id, senderUsername: bot.username,
        messageType: 'text', body: text,
        replyToSeq: replyTo,
        replyMarkup,
        viaBot: true,
        sentAt: stored.sent_at, expiresAt: stored.expires_at, mode: 'cloud',
      },
    });

    return ok(reply, {
      message_id: Number(stored.seq),
      chat_id: chatId,
      text,
      date: stored.sent_at,
    });
  });

  // ─── editMessageText ──────────────────────────────────────
  fastify.post('/bot:token/editMessageText', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['chat_id', 'message_id', 'text'],
        properties: {
          chat_id:    { type: 'string', pattern: UUID_PATTERN },
          message_id: { type: 'integer', minimum: 1 },
          text:       { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH },
          reply_markup: { type: ['object', 'null'], additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    const { chat_id: chatId, message_id: seq, text,
      reply_markup: replyMarkup = null } = request.body;

    // Authorship is enforced in the UPDATE, so a bot cannot rewrite anyone
    // else's message — including another bot's.
    const edited = await fastify.repos.messages.editCloudMessage(chatId, seq, bot.id, {
      body: text,
    });
    if (!edited) return fail(reply, 400, 'Message not found or not editable by this bot');

    if (replyMarkup !== null) {
      await fastify.repos.messages.setReplyMarkup(chatId, seq, replyMarkup);
    }

    const memberIds = await fastify.repos.chats.memberIds(chatId);
    await fastify.fanout.deliverToUsers(memberIds, {
      type: 'message_edited', chatId, seq, body: text, replyMarkup,
    });

    return ok(reply, { message_id: seq, chat_id: chatId, text });
  });

  // ─── answerCallbackQuery ──────────────────────────────────
  fastify.post('/bot:token/answerCallbackQuery', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['callback_query_id'],
        properties: {
          callback_query_id: { type: 'string', pattern: UUID_PATTERN },
          text:       { type: ['string', 'null'], maxLength: 200 },
          show_alert: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    const { callback_query_id: queryId, text = null, show_alert: showAlert = false }
      = request.body;

    // Scoped to this bot and to unexpired queries in one statement: answering
    // another bot's callback, or a stale one, both simply fail.
    const answered = await fastify.repos.bots.answerCallbackQuery(bot.id, queryId);
    if (!answered) return fail(reply, 400, 'Query is unknown, expired, or already answered');

    if (text) {
      await fastify.fanout.deliverToUser(request.callbackUserId ?? bot.id, {
        type: 'callback_answer', queryId, text, showAlert,
      });
    }

    return ok(reply, true);
  });

  // ─── answerInlineQuery ────────────────────────────────────
  fastify.post('/bot:token/answerInlineQuery', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['inline_query_id', 'results'],
        properties: {
          inline_query_id: { type: 'string', pattern: UUID_PATTERN },
          results: {
            type: 'array', maxItems: 50,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    const answered = await fastify.repos.bots.answerInlineQuery(
      bot.id, request.body.inline_query_id, request.body.results
    );
    if (!answered) return fail(reply, 400, 'Query is unknown or expired');
    return ok(reply, true);
  });

  // ─── setMyCommands / getMyCommands ────────────────────────
  fastify.post('/bot:token/setMyCommands', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['commands'],
        properties: {
          commands: {
            type: 'array', maxItems: 100,
            items: {
              type: 'object',
              required: ['command', 'description'],
              properties: {
                command:     { type: 'string', minLength: 1, maxLength: 32 },
                description: { type: 'string', minLength: 1, maxLength: 256 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;
    await fastify.repos.bots.setCommands(bot.id, request.body.commands);
    return ok(reply, true);
  });

  fastify.post('/bot:token/getMyCommands', {
    schema: { params: tokenParam },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;
    return ok(reply, await fastify.repos.bots.getCommands(bot.id));
  });

  // ─── setWebhook / deleteWebhook ───────────────────────────
  fastify.post('/bot:token/setWebhook', {
    schema: {
      params: tokenParam,
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', maxLength: 512 },
          secret_token: { type: ['string', 'null'], maxLength: 256 },
        },
      },
    },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;

    // The same SSRF guard link previews use. A webhook URL is attacker-chosen
    // by definition — anyone can register a bot — so pointing one at
    // 169.254.169.254 or an internal service must be impossible, not merely
    // discouraged.
    const validated = fastify.validateOutboundUrl(request.body.url);
    if (!validated.ok) {
      return fail(reply, 400, `Webhook URL is not allowed: ${validated.reason}`);
    }

    await fastify.repos.bots.setWebhook(
      bot.id, request.body.url, request.body.secret_token ?? null
    );
    return ok(reply, true);
  });

  fastify.post('/bot:token/deleteWebhook', {
    schema: { params: tokenParam },
  }, async (request, reply) => {
    const bot = await authenticateBot(request, reply);
    if (!bot) return undefined;
    await fastify.repos.bots.clearWebhook(bot.id);
    return ok(reply, true);
  });
}

export default botApiRoutes;
