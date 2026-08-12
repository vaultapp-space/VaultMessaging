import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Deleting a chat. The whole risk in this feature is blast radius: "delete
// this conversation" is one button that could plausibly mean four different
// things, and three of them destroy data belonging to someone who did not ask.
//
// So the tests that matter are the negative ones — that the other participant
// keeps their copy, that they can still reach you afterwards, and that the
// conversation comes back rather than becoming a block nobody was told about.

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

// Cloud mode explicitly. A secret chat is the default and the right one for
// the product, but POST /api/chats/:chatId/messages hard-rejects it with 400 —
// handing the server plaintext for a supposedly E2EE conversation is the worst
// failure this codebase could have. Clearing is mode-agnostic, so exercising it
// through the mode that has a server-side send path tests the same code.
async function openChat(user, peerId) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chats/private',
    headers: { cookie: user.cookie },
    payload: { peerId, mode: 'cloud' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body);
}

async function send(user, chatId, body) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie },
    payload: { body },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body);
}

async function listChats(user) {
  const res = await app.inject({
    method: 'GET', url: '/api/chats', headers: { cookie: user.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body).chats ?? JSON.parse(res.body);
}

async function history(user, chatId) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const parsed = JSON.parse(res.body);
  return parsed.messages ?? parsed;
}

function del(user, chatId) {
  return app.inject({
    method: 'DELETE', url: `/api/chats/${chatId}`, headers: { cookie: user.cookie },
  });
}

async function pair() {
  const alice = await registerUser(app);
  const bob = await registerUser(app);
  const { rows } = await harness.store.pool.query(
    'SELECT id, username FROM users WHERE username = ANY($1)',
    [[alice.username, bob.username]]
  );
  const idOf = (u) => rows.find((r) => r.username === u.username).id;
  return { alice, bob, aliceId: idOf(alice), bobId: idOf(bob) };
}

describe('deleting a chat', () => {
  test('removes it from your list and your history', async () => {
    const { alice, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'something');

    assert.equal((await listChats(alice)).length, 1);
    assert.equal((await history(alice, chat.id)).length, 1);

    const res = await del(alice, chat.id);
    assert.equal(res.statusCode, 204);

    assert.equal((await listChats(alice)).length, 0, 'gone from the list');
    assert.equal((await history(alice, chat.id)).length, 0, 'gone from history');
  });

  test('leaves the other participant untouched', async () => {
    // The one that must never regress. Deleting your copy of a conversation
    // must not reach into someone else's account.
    const { alice, bob, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'still theirs');

    await del(alice, chat.id);

    assert.equal((await listChats(bob)).length, 1, 'bob still has the chat');
    const bobsHistory = await history(bob, chat.id);
    assert.equal(bobsHistory.length, 1, 'bob still has the message');
  });

  test('the other participant can still reach you afterwards', async () => {
    // If deleting dropped membership, this send would fail and "delete" would
    // silently mean "block" — the failure mode the implementation is shaped
    // to avoid.
    const { alice, bob, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'first');

    await del(alice, chat.id);

    await send(bob, chat.id, 'are you there');
  });

  test('the chat comes back when something new arrives, without the old messages', async () => {
    const { alice, bob, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'old news');

    await del(alice, chat.id);
    assert.equal((await listChats(alice)).length, 0);

    await send(bob, chat.id, 'new news');

    const list = await listChats(alice);
    assert.equal(list.length, 1, 'a resumed conversation reappears');

    // Only what arrived after the clear. The point of deleting was to be rid
    // of the rest, and a chat that returns carrying its whole history back
    // would make the button meaningless.
    const seen = await history(alice, chat.id);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body, 'new news');
  });

  test('an empty chat stays deleted', async () => {
    // last_message_at is NULL here, so a naive comparison against cleared_at
    // leaves it visible forever — the case most likely to be got wrong.
    const { alice, bobId } = await pair();
    const chat = await openChat(alice, bobId);

    await del(alice, chat.id);

    assert.equal((await listChats(alice)).length, 0);
  });

  test('deleting twice is harmless', async () => {
    const { alice, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'x');

    assert.equal((await del(alice, chat.id)).statusCode, 204);
    assert.equal((await del(alice, chat.id)).statusCode, 204);
    assert.equal((await listChats(alice)).length, 0);
  });

  test('sets a read watermark even with no prior read state', async () => {
    // Alice has only ever sent, so nothing has created a chat_read_state row
    // for her. Without an upsert in clearFor she keeps no watermark, and
    // reconcileUnread — which recomputes from `seq > read_inbox_max_seq`,
    // defaulting to 0 — then counts every cleared message as unread as soon
    // as one new message lands. Right in the common case, wrong in the one
    // nobody checks by hand.
    const { alice, bob, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(alice, chat.id, 'one');
    await send(alice, chat.id, 'two');
    await send(alice, chat.id, 'three');

    await del(alice, chat.id);
    await send(bob, chat.id, 'just this one');

    // Force the reconciliation the reaper performs on its own schedule, so
    // the assertion covers the recomputed value rather than the incremented
    // one.
    await harness.store.reconcileUnread([chat.id]);

    const [row] = await listChats(alice);
    assert.equal(row.unreadCount, 1);
  });

  test('hides history on the secret path too, not just the cloud one', async () => {
    // Secret is the default mode for a one-to-one chat, and it reads its
    // history from GET /api/messages/:peerId — a different query, keyed by the
    // user pair rather than by chat_id. Filtering only the cloud path would
    // mean the chat most people actually have disappears from the list and
    // then hands its whole history back the moment they reopen it.
    const { alice, bob, aliceId, bobId } = await pair();

    const created = await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie },
      payload: { peerId: bobId },   // no mode → secret
    });
    assert.equal(created.statusCode, 201, created.body);
    const chat = JSON.parse(created.body);
    assert.equal(chat.mode, 'secret', 'precondition: the default is secret');

    // Seeded directly: a real secret message is an encrypted envelope built by
    // the client, and none of that is what this test is about.
    await harness.store.pool.query(
      `INSERT INTO messages (chat_id, seq, sender_id, recipient_id, ciphertext, iv, expires_at, sent_at)
       VALUES ($1, 1, $2, $3, 'x', 'y', now() + interval '1 hour', now())`,
      [chat.id, bobId, aliceId]
    );

    const url = `/api/messages/${bobId}`;
    const before = await app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } });
    assert.equal(JSON.parse(before.body).messages.length, 1, 'precondition');

    await del(alice, chat.id);

    const after = await app.inject({ method: 'GET', url, headers: { cookie: alice.cookie } });
    assert.equal(JSON.parse(after.body).messages.length, 0, 'cleared on the secret path');

    // And bob still has it.
    const bobsView = await app.inject({
      method: 'GET', url: `/api/messages/${aliceId}`, headers: { cookie: bob.cookie },
    });
    assert.equal(JSON.parse(bobsView.body).messages.length, 1);
  });

  test('a stranger gets 404, not a clue', async () => {
    const { alice, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    const mallory = await registerUser(app);

    const res = await del(mallory, chat.id);
    assert.equal(res.statusCode, 404);

    // And the chat is untouched for the people actually in it.
    assert.equal((await listChats(alice)).length, 1);
  });

  test('clears the unread badge, so a returning chat does not carry a stale count', async () => {
    const { alice, bob, aliceId, bobId } = await pair();
    const chat = await openChat(alice, bobId);
    await send(bob, chat.id, 'unread one');
    await send(bob, chat.id, 'unread two');

    const before = (await listChats(alice))[0];
    assert.ok(before.unreadCount > 0, 'precondition: alice has unread messages');

    await del(alice, chat.id);
    await send(bob, chat.id, 'after the delete');

    const after = (await listChats(alice))[0];
    assert.equal(after.unreadCount, 1, 'only the message that arrived after');
    assert.ok(aliceId && bobId);
  });
});
