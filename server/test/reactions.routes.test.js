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

async function openChat(user, peerId, mode = 'cloud') {
  const res = await app.inject({
    method: 'POST', url: '/api/chats/private',
    headers: { cookie: user.cookie }, payload: { peerId, mode },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function sendMessage(user, chatId, body = 'react to me') {
  const res = await app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload: { body },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function react(user, chatId, seq, emoji) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages/${seq}/reactions`,
    headers: { cookie: user.cookie }, payload: { emoji },
  });
}

function unreact(user, chatId, seq, emoji) {
  return app.inject({
    method: 'DELETE',
    url: `/api/chats/${chatId}/messages/${seq}/reactions/${encodeURIComponent(emoji)}`,
    headers: { cookie: user.cookie },
  });
}

async function setup() {
  const alice = await registerUser(app);
  const bob = await registerUser(app);
  const chat = await openChat(alice, bob.id);
  const message = await sendMessage(alice, chat.id);
  return { alice, bob, chat, message };
}

describe('adding reactions', () => {
  test('records a reaction and returns the summary', async () => {
    const { bob, chat, message } = await setup();

    const res = await react(bob, chat.id, message.seq, '🔥');

    assert.equal(res.statusCode, 201);
    const { reactions } = res.json();
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].emoji, '🔥');
    assert.equal(Number(reactions[0].count), 1);
    assert.deepEqual(reactions[0].users, [bob.id]);
  });

  test('several users on the same emoji are counted together', async () => {
    const { alice, bob, chat, message } = await setup();

    await react(alice, chat.id, message.seq, '👍');
    const res = await react(bob, chat.id, message.seq, '👍');

    const entry = res.json().reactions.find((r) => r.emoji === '👍');
    assert.equal(Number(entry.count), 2);
    assert.equal(entry.users.length, 2);
  });

  test('one user can add different emoji to the same message', async () => {
    const { bob, chat, message } = await setup();

    await react(bob, chat.id, message.seq, '🔥');
    const res = await react(bob, chat.id, message.seq, '🎉');

    assert.equal(res.json().reactions.length, 2);
  });

  test('reacting twice with the same emoji is idempotent', async () => {
    // A double-tap should not error or double-count.
    const { bob, chat, message } = await setup();

    await react(bob, chat.id, message.seq, '🔥');
    const res = await react(bob, chat.id, message.seq, '🔥');

    assert.equal(res.statusCode, 201);
    assert.equal(Number(res.json().reactions[0].count), 1);
  });

  test('the denormalised summary matches the rows', async () => {
    // The message list renders from messages.reactions and never joins, so a
    // drift between the two would make the UI silently wrong.
    const { alice, bob, chat, message } = await setup();

    await react(alice, chat.id, message.seq, '👍');
    await react(bob, chat.id, message.seq, '👍');
    await react(bob, chat.id, message.seq, '🔥');

    const { rows } = await harness.store.pool.query(
      `SELECT reactions FROM messages WHERE chat_id = $1 AND seq = $2`,
      [chat.id, message.seq]
    );
    const summary = rows[0].reactions;
    const rowsForMessage = await harness.store.reactions.listFor(chat.id, message.seq);

    const summaryTotal = summary.reduce((n, r) => n + Number(r.count), 0);
    assert.equal(summaryTotal, rowsForMessage.length);
    assert.equal(summary.length, 2, 'two distinct emoji');
  });

  test('404s for a message that does not exist', async () => {
    const { bob, chat } = await setup();
    const res = await react(bob, chat.id, 9999, '🔥');
    assert.equal(res.statusCode, 404);
  });

  test('rejects an empty emoji', async () => {
    const { bob, chat, message } = await setup();
    const res = await react(bob, chat.id, message.seq, '');
    assert.equal(res.statusCode, 400);
  });
});

describe('removing reactions', () => {
  test('removes only the caller’s own reaction', async () => {
    const { alice, bob, chat, message } = await setup();

    await react(alice, chat.id, message.seq, '👍');
    await react(bob, chat.id, message.seq, '👍');

    const res = await unreact(bob, chat.id, message.seq, '👍');

    const entry = res.json().reactions.find((r) => r.emoji === '👍');
    assert.equal(Number(entry.count), 1);
    assert.deepEqual(entry.users, [alice.id], 'alice keeps hers');
  });

  test('the entry disappears when the last one goes', async () => {
    const { bob, chat, message } = await setup();

    await react(bob, chat.id, message.seq, '🔥');
    const res = await unreact(bob, chat.id, message.seq, '🔥');

    assert.deepEqual(res.json().reactions, []);
  });

  test('removing one that was never added is a no-op', async () => {
    const { bob, chat, message } = await setup();
    const res = await unreact(bob, chat.id, message.seq, '🔥');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().reactions, []);
  });
});

describe('authorisation', () => {
  test('a non-member cannot react', async () => {
    const { chat, message } = await setup();
    const mallory = await registerUser(app);

    const res = await react(mallory, chat.id, message.seq, '🔥');
    assert.equal(res.statusCode, 404, 'and gets 404, not 403 — no existence leak');
  });

  test('requires authentication', async () => {
    const { chat, message } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/messages/${message.seq}/reactions`,
      payload: { emoji: '🔥' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('a secret chat refuses server-side reactions', async () => {
    // Same reasoning as the plaintext guard on sends: recording who reacted to
    // what, in the clear, in an end-to-end encrypted conversation would defeat
    // the point. Secret-chat reactions ride the ratchet as t:'op' envelopes.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const secret = await openChat(alice, bob.id, 'secret');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${secret.id}/messages/1/reactions`,
      headers: { cookie: bob.cookie }, payload: { emoji: '🔥' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /end-to-end encrypted/i);

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM reactions WHERE chat_id = $1`, [secret.id]
    );
    assert.equal(rows[0].n, 0, 'nothing was recorded');
  });
});

describe('retention', () => {
  test('reactions die with the message they are on', async () => {
    // The 24h rule reaches transitively: a reaction must never outlive what it
    // reacted to. Enforced by ON DELETE CASCADE on (chat_id, seq).
    const { bob, chat, message } = await setup();
    await react(bob, chat.id, message.seq, '🔥');

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second' WHERE chat_id = $1`,
      [chat.id]
    );
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM reactions WHERE chat_id = $1`, [chat.id]
    );
    assert.equal(rows[0].n, 0);
  });

  test('reactions appear on the fetched message', async () => {
    const { bob, chat, message } = await setup();
    await react(bob, chat.id, message.seq, '🎉');

    const res = await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: bob.cookie },
    });

    const fetched = res.json().messages.find((m) => m.seq === message.seq);
    assert.equal(fetched.reactions.length, 1);
    assert.equal(fetched.reactions[0].emoji, '🎉');
  });
});
