import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// The reaper reports which chats it emptied, so unread counters can be
// recomputed for those chats alone.
//
// Before this, the caller ran reconcileUnread() with no argument on every pass
// that deleted anything — recomputing every user-and-chat pair in the database
// against the messages table, once a minute, for as long as anything was
// expiring. Correct, and the most expensive recurring query in the system once
// there is real data in it.

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

async function cloudChat(a, bId) {
  const res = await app.inject({
    method: 'POST', url: '/api/chats/private',
    headers: { cookie: a.cookie }, payload: { peerId: bId, mode: 'cloud' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).id;
}

async function send(user, chatId, body) {
  const res = await app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload: { body },
  });
  assert.equal(res.statusCode, 201, res.body);
}

describe('the reaper reports what it touched', () => {
  test('returns a count and the chats that lost messages', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chatId = await cloudChat(alice, bob.id);
    await send(alice, chatId, 'one');
    await send(alice, chatId, 'two');

    await harness.store.pool.query(`UPDATE messages SET expires_at = now() - interval '1 minute'`);
    const result = await harness.store.reap();

    assert.equal(result.messages, 2);
    assert.deepEqual(result.chatIds, [chatId], 'one entry, de-duplicated');
  });

  test('names only the chats that actually expired', async () => {
    // The whole point: an untouched chat must not be dragged into the
    // recompute.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const withBob = await cloudChat(alice, bob.id);
    const withCarol = await cloudChat(alice, carol.id);

    await send(alice, withBob, 'expiring');
    await send(alice, withCarol, 'staying');

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 minute' WHERE chat_id = $1`,
      [withBob]
    );
    const result = await harness.store.reap();

    assert.deepEqual(result.chatIds, [withBob]);
  });

  test('reports nothing when nothing expired', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await send(alice, await cloudChat(alice, bob.id), 'fresh');

    const result = await harness.store.reap();

    assert.equal(result.messages, 0);
    assert.deepEqual(result.chatIds, []);
  });

  test('the scoped reconcile fixes the counter it was given', async () => {
    // Proves the narrowing did not break the thing it optimises: a chat whose
    // messages expired must still end up with a correct unread count.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chatId = await cloudChat(alice, bob.id);
    await send(bob, chatId, 'unread by alice');

    const before = await harness.store.pool.query(
      'SELECT unread_count FROM chat_read_state WHERE chat_id = $1', [chatId]
    );
    assert.ok(before.rows.some((r) => r.unread_count > 0), 'precondition');

    await harness.store.pool.query(`UPDATE messages SET expires_at = now() - interval '1 minute'`);
    const { chatIds } = await harness.store.reap();
    await harness.store.chats.reconcileUnread(chatIds);

    const after = await harness.store.pool.query(
      'SELECT unread_count FROM chat_read_state WHERE chat_id = $1', [chatId]
    );
    assert.ok(
      after.rows.every((r) => r.unread_count === 0),
      'a chat with no messages left cannot have unread ones'
    );
  });
});
