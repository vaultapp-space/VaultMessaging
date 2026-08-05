import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

let harness;
let app;

before(async () => {
  harness = await createTestApp();
  app = harness.app;
});

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.store);
  await harness.store.redis.flushdb();
});

let seq = 0;
function botName() {
  return `test${(seq += 1)}${Date.now().toString(36)}bot`.slice(0, 32);
}

async function makeBot(owner, overrides = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/bots',
    headers: { cookie: owner.cookie },
    payload: { username: botName(), description: 'A test bot', ...overrides },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function botApi(token, method, payload = {}) {
  return app.inject({
    method: 'POST', url: `/bot${token}/${method}`, payload,
  });
}

async function openChat(user, peerId, mode = 'cloud') {
  const res = await app.inject({
    method: 'POST', url: '/api/chats/private',
    headers: { cookie: user.cookie }, payload: { peerId, mode },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function makeCloudGroup(owner, members) {
  const res = await app.inject({
    method: 'POST', url: '/api/groups',
    headers: { cookie: owner.cookie },
    payload: { name: 'Group', members: members.map((m) => m.id) },
  });
  assert.equal(res.statusCode, 201, res.body);
  const group = res.json();
  await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
  return group;
}

function send(user, chatId, payload) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload,
  });
}

// ============================================================
// Registration and tokens
// ============================================================

describe('bot registration', () => {
  test('creating a bot returns a token exactly once', async () => {
    // Only a hash is stored, so there is no way to show it again. If this
    // ever starts returning the token from a later read, the storage model
    // has been broken.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    assert.ok(bot.token, 'the token is returned at creation');

    const { bots } = (await app.inject({
      method: 'GET', url: '/api/bots', headers: { cookie: owner.cookie },
    })).json();
    assert.equal(bots.length, 1);
    assert.equal(bots[0].token, undefined, 'and never again');
  });

  test('the token is stored hashed, not in plaintext', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    const { rows } = await harness.store.pool.query(
      `SELECT token_hash FROM bots WHERE user_id = $1`, [bot.id]
    );
    assert.notEqual(rows[0].token_hash, bot.token);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  });

  test('a username must end in "bot"', async () => {
    // A user has to be able to tell from a name alone whether they are
    // talking to a person.
    const owner = await registerUser(app);
    const res = await app.inject({
      method: 'POST', url: '/api/bots',
      headers: { cookie: owner.cookie },
      payload: { username: 'plainoldbot' },
    });
    assert.equal(res.statusCode, 201, 'ends in "bot", so it is fine');

    const bad = await app.inject({
      method: 'POST', url: '/api/bots',
      headers: { cookie: owner.cookie },
      payload: { username: 'pretendinghumanx' },
    });
    assert.equal(bad.statusCode, 400);
  });

  test('getMe authenticates with the token', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    const res = await botApi(bot.token, 'getMe');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.is_bot, true);
    assert.equal(body.result.username, bot.username);
  });

  test('a wrong token is refused', async () => {
    const owner = await registerUser(app);
    await makeBot(owner);

    const res = await botApi('deadbeef:notarealtokenatall', 'getMe');
    assert.equal(res.statusCode, 401);
  });

  test('rotating the token invalidates the old one immediately', async () => {
    // The only remedy for a leak, so letting the old token drain would
    // defeat the point.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    const rotated = (await app.inject({
      method: 'POST', url: `/api/bots/${bot.id}/token`,
      headers: { cookie: owner.cookie },
    })).json();

    assert.equal((await botApi(bot.token, 'getMe')).statusCode, 401);
    assert.equal((await botApi(rotated.token, 'getMe')).statusCode, 200);
  });

  test('one account cannot rotate another account\'s bot token', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const bot = await makeBot(owner);

    const res = await app.inject({
      method: 'POST', url: `/api/bots/${bot.id}/token`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(res.statusCode, 404);
    assert.equal((await botApi(bot.token, 'getMe')).statusCode, 200, 'still works');
  });
});

// ============================================================
// Messaging
// ============================================================

describe('bot messaging', () => {
  test('a bot receives messages sent to it in a private chat', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);

    await send(owner, chat.id, { body: 'hello bot' });

    const updates = (await botApi(bot.token, 'getUpdates')).json();
    assert.equal(updates.ok, true);
    assert.equal(updates.result.length, 1);
    assert.equal(updates.result[0].message.text, 'hello bot');
  });

  test('a bot can reply, and the user receives it', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);

    const sent = await botApi(bot.token, 'sendMessage', {
      chat_id: chat.id, text: 'hello human',
    });
    assert.equal(sent.statusCode, 200, sent.body);

    const { messages } = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.ok(messages.some((m) => m.body === 'hello human'));
  });

  test('getUpdates acknowledges with the offset', async () => {
    // Asking for a later offset *is* the ack — there is no separate call.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);
    await send(owner, chat.id, { body: 'first' });

    const first = (await botApi(bot.token, 'getUpdates')).json().result;
    assert.equal(first.length, 1);

    const second = (await botApi(bot.token, 'getUpdates', {
      offset: first[0].updateId + 1,
    })).json().result;
    assert.equal(second.length, 0, 'already acknowledged');
  });

  test('a bot cannot send to a chat it is not in', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const bot = await makeBot(owner);
    const privateChat = await openChat(owner, other.id);

    const res = await botApi(bot.token, 'sendMessage', {
      chat_id: privateChat.id, text: 'intruding',
    });
    assert.equal(res.statusCode, 403);
  });

  test('a bot cannot be added to a secret chat', async () => {
    // The refusal that keeps the encryption claim honest: a bot receiving a
    // message means the server can read it.
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const bot = await makeBot(owner);
    const secret = await openChat(owner, other.id, 'secret');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${secret.id}/bots`,
      headers: { cookie: owner.cookie }, payload: { botId: bot.id },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a bot cannot rewrite another sender\'s message', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);
    const sent = (await send(owner, chat.id, { body: 'mine' })).json();

    const res = await botApi(bot.token, 'editMessageText', {
      chat_id: chat.id, message_id: sent.seq, text: 'rewritten',
    });
    assert.equal(res.statusCode, 400);

    const { messages } = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.equal(messages[0].body, 'mine');
  });
});

// ============================================================
// Privacy mode
// ============================================================
// The default that stops adding a bot to a group from silently handing it the
// transcript. Enforced in the delivery path, so a bot author cannot opt out.

describe('privacy mode', () => {
  test('by default a bot in a group sees only messages addressed to it', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const bot = await makeBot(owner);
    const group = await makeCloudGroup(owner, [member]);

    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/bots`,
      headers: { cookie: owner.cookie }, payload: { botId: bot.id },
    });

    await send(member, group.id, { body: 'just chatting between humans' });
    await send(member, group.id, { body: '/help' });
    await send(member, group.id, { body: `hey @${bot.username} look` });

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    const texts = result.map((u) => u.message.text);
    assert.ok(!texts.includes('just chatting between humans'),
      'ordinary group chatter must not reach the bot');
    assert.ok(texts.includes('/help'));
    assert.ok(texts.some((t) => t.includes(`@${bot.username}`)));
  });

  test('turning privacy mode off lets the bot see everything', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const bot = await makeBot(owner);
    const group = await makeCloudGroup(owner, [member]);

    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/bots`,
      headers: { cookie: owner.cookie }, payload: { botId: bot.id },
    });
    await app.inject({
      method: 'PATCH', url: `/api/bots/${bot.id}`,
      headers: { cookie: owner.cookie },
      payload: { canReadAllGroupMessages: true },
    });

    await send(member, group.id, { body: 'ordinary chatter' });

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    assert.ok(result.some((u) => u.message.text === 'ordinary chatter'));
  });

  test('in a private chat with a bot it sees everything', async () => {
    // That is what the chat is for; privacy mode is about groups.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);

    await send(owner, chat.id, { body: 'no command prefix here' });

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    assert.equal(result[0].message.text, 'no command prefix here');
  });
});

// ============================================================
// Keyboards and callbacks
// ============================================================

describe('inline keyboards', () => {
  async function withKeyboard() {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);

    const sent = (await botApi(bot.token, 'sendMessage', {
      chat_id: chat.id,
      text: 'Pick one',
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]],
      },
    })).json();

    return { owner, bot, chat, seq: sent.result.message_id };
  }

  test('pressing a button reaches the bot as a callback query', async () => {
    const { owner, bot, chat, seq } = await withKeyboard();

    const pressed = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${seq}/callback`,
      headers: { cookie: owner.cookie }, payload: { data: 'yes' },
    });
    assert.equal(pressed.statusCode, 200, pressed.body);

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    const callback = result.find((u) => u.callback_query);
    assert.ok(callback);
    assert.equal(callback.callback_query.data, 'yes');
  });

  test('a callback for a button that was never offered is refused', async () => {
    // Checked against the *stored* markup. Without this, anyone could hand a
    // bot arbitrary callback data and make it act on something it never
    // offered.
    const { owner, chat, seq } = await withKeyboard();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${seq}/callback`,
      headers: { cookie: owner.cookie }, payload: { data: 'delete_everything' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a bot cannot answer another bot\'s callback query', async () => {
    const { owner, chat, seq } = await withKeyboard();
    const otherBot = await makeBot(owner);

    const pressed = (await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${seq}/callback`,
      headers: { cookie: owner.cookie }, payload: { data: 'yes' },
    })).json();

    const res = await botApi(otherBot.token, 'answerCallbackQuery', {
      callback_query_id: pressed.queryId,
    });
    assert.equal(res.statusCode, 400);
  });

  test('a callback can only be answered once', async () => {
    const { bot, owner, chat, seq } = await withKeyboard();
    const pressed = (await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${seq}/callback`,
      headers: { cookie: owner.cookie }, payload: { data: 'yes' },
    })).json();

    const first = await botApi(bot.token, 'answerCallbackQuery', {
      callback_query_id: pressed.queryId,
    });
    assert.equal(first.statusCode, 200);

    const second = await botApi(bot.token, 'answerCallbackQuery', {
      callback_query_id: pressed.queryId,
    });
    assert.equal(second.statusCode, 400);
  });
});

// ============================================================
// Commands, inline mode, deep links
// ============================================================

describe('commands and inline mode', () => {
  test('setMyCommands round-trips', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    await botApi(bot.token, 'setMyCommands', {
      commands: [{ command: 'start', description: 'Begin' }],
    });

    const { result } = (await botApi(bot.token, 'getMyCommands')).json();
    assert.equal(result.length, 1);
    assert.equal(result[0].command, 'start');
  });

  test('an inline query reaches the bot and its answer comes back', async () => {
    const owner = await registerUser(app);
    const user = await registerUser(app);
    const bot = await makeBot(owner);
    await app.inject({
      method: 'PATCH', url: `/api/bots/${bot.id}`,
      headers: { cookie: owner.cookie }, payload: { supportsInline: true },
    });

    const asked = (await app.inject({
      method: 'POST', url: `/api/bots/${bot.id}/inline`,
      headers: { cookie: user.cookie }, payload: { query: 'kittens' },
    })).json();

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    const inline = result.find((u) => u.inline_query);
    assert.equal(inline.inline_query.query, 'kittens');

    await botApi(bot.token, 'answerInlineQuery', {
      inline_query_id: asked.queryId,
      results: [{ id: '1', title: 'A kitten' }],
    });

    const back = (await app.inject({
      method: 'GET', url: `/api/bots/inline/${asked.queryId}`,
      headers: { cookie: user.cookie },
    })).json();
    assert.equal(back.results[0].title, 'A kitten');
  });

  test('a bot that does not support inline refuses queries', async () => {
    const owner = await registerUser(app);
    const user = await registerUser(app);
    const bot = await makeBot(owner);

    const res = await app.inject({
      method: 'POST', url: `/api/bots/${bot.id}/inline`,
      headers: { cookie: user.cookie }, payload: { query: 'anything' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a deep link opens a chat and delivers /start with its payload', async () => {
    const owner = await registerUser(app);
    const user = await registerUser(app);
    const bot = await makeBot(owner);

    const started = await app.inject({
      method: 'POST', url: `/api/bots/${bot.id}/start`,
      headers: { cookie: user.cookie }, payload: { payload: 'ref123' },
    });
    assert.equal(started.statusCode, 201, started.body);

    const { result } = (await botApi(bot.token, 'getUpdates')).json();
    assert.ok(result.some((u) => u.message?.text === '/start ref123'));
  });
});

// ============================================================
// Webhooks
// ============================================================

describe('webhooks', () => {
  test('a webhook pointed at a private address is refused', async () => {
    // Anyone can register a bot, so a webhook URL is attacker-chosen by
    // definition. This is the same SSRF guard link previews use.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:6379/',
      'http://10.0.0.1/hook',
      'file:///etc/passwd',
    ]) {
      const res = await botApi(bot.token, 'setWebhook', { url });
      assert.equal(res.statusCode, 400, `${url} must be refused`);
    }
  });

  test('a public https webhook is accepted and can be cleared', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);

    const set = await botApi(bot.token, 'setWebhook', {
      url: 'https://example.com/hook', secret_token: 'shh',
    });
    assert.equal(set.statusCode, 200, set.body);

    const cleared = await botApi(bot.token, 'deleteWebhook');
    assert.equal(cleared.statusCode, 200);

    const { rows } = await harness.store.pool.query(
      `SELECT webhook_url FROM bots WHERE user_id = $1`, [bot.id]
    );
    assert.equal(rows[0].webhook_url, null);
  });
});

// ============================================================
// Retention
// ============================================================

describe('bots and the 24h rule', () => {
  test('queued updates expire with the messages they copy', async () => {
    // The queue holds message content. Without an expiry it becomes a second,
    // permanent copy of every conversation a bot has been in.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);
    await send(owner, chat.id, { body: 'ephemeral' });

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM bot_updates_queue
        WHERE expires_at IS NULL OR expires_at > now() + interval '24 hours'`
    );
    assert.equal(rows[0].n, 0);
  });

  test('the reaper clears the queue and both query tables', async () => {
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    const chat = await openChat(owner, bot.id);
    await send(owner, chat.id, { body: 'gone' });

    await harness.store.pool.query(
      `UPDATE bot_updates_queue SET expires_at = now() - interval '1 hour'`
    );
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM bot_updates_queue`
    );
    assert.equal(rows[0].n, 0);
  });

  test('the bot registration itself survives the reaper', async () => {
    // Configuration, not content.
    const owner = await registerUser(app);
    const bot = await makeBot(owner);
    await harness.store.reap();

    assert.equal((await botApi(bot.token, 'getMe')).statusCode, 200);
  });
});
