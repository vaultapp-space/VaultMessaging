import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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

async function openPrivateChat(user, peerId, mode = 'cloud') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chats/private',
    headers: { cookie: user.cookie },
    payload: { peerId, mode },
  });
  assert.equal(res.statusCode, 201, `open chat failed: ${res.body}`);
  return res.json();
}

async function listChats(user) {
  const res = await app.inject({
    method: 'GET', url: '/api/chats', headers: { cookie: user.cookie },
  });
  assert.equal(res.statusCode, 200);
  return res.json().chats;
}

// Inserts a message directly, so tests can control seq and expiry precisely.
async function insertMessage(chatId, senderId, { seq, body = 'hi', expiresInMs = 3600_000 }) {
  const { rows } = await harness.store.pool.query(
    `INSERT INTO messages (chat_id, seq, sender_id, ciphertext, body, expires_at, sent_at)
     VALUES ($1, $2, $3, '', $4, now() + ($5 || ' milliseconds')::interval, now())
     RETURNING id`,
    [chatId, seq, senderId, body, String(expiresInMs)]
  );
  await harness.store.pool.query(
    `UPDATE chats SET last_seq = GREATEST(last_seq, $2), last_message_at = now() WHERE id = $1`,
    [chatId, seq]
  );
  return rows[0].id;
}

describe('POST /api/chats/private', () => {
  test('creates a private chat with both participants', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const chat = await openPrivateChat(alice, bob.id);

    assert.equal(chat.type, 'private');
    assert.equal(chat.members.length, 2);
    assert.deepEqual(chat.members.map((m) => m.id).sort(), [alice.id, bob.id].sort());
  });

  test('is idempotent and converges from either side', async () => {
    // The id is derived from the pair, so both participants opening the chat
    // at the same time must land on one chat, not two.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const fromAlice = await openPrivateChat(alice, bob.id);
    const fromBob = await openPrivateChat(bob, alice.id);

    assert.equal(fromAlice.id, fromBob.id);
    assert.equal((await listChats(alice)).length, 1);
  });

  test('concurrent opens do not create duplicates', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await Promise.all([
      openPrivateChat(alice, bob.id),
      openPrivateChat(bob, alice.id),
      openPrivateChat(alice, bob.id),
    ]);

    assert.equal((await listChats(alice)).length, 1);
  });

  test('defaults to cloud mode but can create a secret chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    assert.equal((await openPrivateChat(alice, bob.id)).mode, 'cloud');
    assert.equal((await openPrivateChat(alice, carol.id, 'secret')).mode, 'secret');
  });

  test('rejects opening a chat with yourself', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: alice.id },
    });
    assert.equal(res.statusCode, 400);
  });

  test('404s for an unknown peer', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: randomUUID() },
    });
    assert.equal(res.statusCode, 404);
  });

  test('requires authentication', async () => {
    const bob = await registerUser(app);
    const res = await app.inject({
      method: 'POST', url: '/api/chats/private', payload: { peerId: bob.id },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('GET /api/chats', () => {
  test('lists chats the caller belongs to, and only those', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    const chat = await openPrivateChat(alice, bob.id);

    assert.ok((await listChats(alice)).some((c) => c.id === chat.id));
    assert.ok((await listChats(bob)).some((c) => c.id === chat.id));
    assert.equal((await listChats(mallory)).length, 0, 'an outsider sees nothing');
  });

  test('names a private chat after the other participant', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await openPrivateChat(alice, bob.id);

    const [chat] = await listChats(alice);
    assert.equal(chat.title, bob.username);
    assert.equal(chat.peerId, bob.id);
  });

  test('orders by most recent activity', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    const withBob = await openPrivateChat(alice, bob.id);
    const withCarol = await openPrivateChat(alice, carol.id);

    await insertMessage(withBob.id, alice.id, { seq: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await insertMessage(withCarol.id, alice.id, { seq: 1 });

    const chats = await listChats(alice);
    assert.equal(chats[0].id, withCarol.id, 'most recent first');
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats' });
    assert.equal(res.statusCode, 401);
  });
});

// ============================================================
// The 24-hour rule
// ============================================================
// These are the standing guards from the plan. They exist because this
// invariant erodes one convenient change at a time, and because the failure
// modes are silent — nothing throws when a chat quietly disappears or a
// message quietly outlives its expiry.

describe('retention invariants', () => {
  test('messages.expires_at is NOT NULL at the schema level', async () => {
    // A migration that relaxes this must fail here, loudly.
    const { rows } = await harness.store.pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'expires_at'`
    );
    assert.equal(rows[0].is_nullable, 'NO');
  });

  test('a per-chat TTL can never exceed 24 hours', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await assert.rejects(
      harness.store.pool.query(
        `UPDATE chats SET default_ttl_secs = 172800 WHERE id = $1`, [chat.id]
      ),
      /check constraint/i,
      'the database must refuse a TTL beyond the ceiling'
    );
  });

  test('resolveTtlSeconds clamps every input to the ceiling', async () => {
    const { chats } = harness.store;
    const DAY = 86400;

    assert.equal(chats.resolveTtlSeconds({ requestedSeconds: DAY * 7 }), DAY, 'clamps a long request');
    assert.equal(chats.resolveTtlSeconds({ chatDefaultSeconds: DAY * 7 }), DAY, 'clamps a long chat default');
    assert.equal(chats.resolveTtlSeconds({ requestedSeconds: 600 }), 600, 'honours a shorter request');
    assert.equal(chats.resolveTtlSeconds({ requestedSeconds: 600, chatDefaultSeconds: 60 }), 60,
      'the shortest wins — a per-chat TTL may only shorten');
    assert.equal(chats.resolveTtlSeconds({}), DAY, 'defaults to the ceiling');
    assert.equal(chats.resolveTtlSeconds({ requestedSeconds: -1 }), DAY, 'ignores nonsense');
  });

  test('the reaper deletes expired messages', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, alice.id, { seq: 1, expiresInMs: -1000 });
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1`, [chat.id]
    );
    assert.equal(rows[0].n, 0);
  });
});

describe('empty chats survive their messages', () => {
  test('a chat whose messages expired stays in the list', async () => {
    // The decided behaviour: chats are durable, contents are ephemeral.
    // Without this, a conversation vanishes after a quiet day and the peer
    // has to be searched for again — which reads as lost contacts.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1, expiresInMs: -1000 });
    await harness.store.reap();

    const chats = await listChats(alice);
    const found = chats.find((c) => c.id === chat.id);

    assert.ok(found, 'the chat must still be listed');
    assert.equal(found.isEmpty, true, 'and be reported as empty');
  });

  test('last_message_at survives the message it refers to', async () => {
    // It is the sort key; the reaper must never rewrite it.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1, expiresInMs: -1000 });
    await harness.store.reap();

    const found = (await listChats(alice)).find((c) => c.id === chat.id);
    assert.ok(found.lastMessageAt, 'ordering information is retained');
  });

  test('unread counts are reconciled to zero when messages expire', async () => {
    // A chat must never sit at "3 unread" with nothing to show.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1, expiresInMs: -1000 });
    await harness.store.chats.incrementUnread(chat.id, bob.id);

    const before = (await listChats(alice)).find((c) => c.id === chat.id);
    assert.equal(before.unreadCount, 1, 'precondition: alice has an unread message');

    await harness.store.reap();
    await harness.store.chats.reconcileUnread();

    const after = (await listChats(alice)).find((c) => c.id === chat.id);
    assert.equal(after.unreadCount, 0, 'no unread badge without messages');
  });

  test('a chat with live messages is not reported as empty', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1, expiresInMs: 3600_000 });

    const found = (await listChats(alice)).find((c) => c.id === chat.id);
    assert.equal(found.isEmpty, false);
  });
});

describe('read state', () => {
  test('marking read clears the unread count', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1 });
    await insertMessage(chat.id, bob.id, { seq: 2 });
    await harness.store.chats.incrementUnread(chat.id, bob.id);
    await harness.store.chats.incrementUnread(chat.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/read`,
      headers: { cookie: alice.cookie }, payload: { maxSeq: 2 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().unreadCount, 0);
    assert.equal(res.json().readInboxMaxSeq, 2);
  });

  test('a partial read leaves the remainder unread', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    await insertMessage(chat.id, bob.id, { seq: 1 });
    await insertMessage(chat.id, bob.id, { seq: 2 });
    await insertMessage(chat.id, bob.id, { seq: 3 });

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/read`,
      headers: { cookie: alice.cookie }, payload: { maxSeq: 1 },
    });
    assert.equal(res.json().unreadCount, 2);
  });

  test('the watermark never moves backwards', async () => {
    // Out-of-order acks from two devices must not resurrect read messages.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);
    await insertMessage(chat.id, bob.id, { seq: 1 });
    await insertMessage(chat.id, bob.id, { seq: 2 });

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/read`,
      headers: { cookie: alice.cookie }, payload: { maxSeq: 2 },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/read`,
      headers: { cookie: alice.cookie }, payload: { maxSeq: 1 },
    });

    assert.equal(res.json().readInboxMaxSeq, 2);
  });

  test('a non-member cannot mark a chat read', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/read`,
      headers: { cookie: mallory.cookie }, payload: { maxSeq: 1 },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/chats/:chatId', () => {
  test('returns the chat with its members', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    const res = await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}`, headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().members.length, 2);
  });

  test('a non-member gets 404, not 403', async () => {
    // Probing an id must not reveal whether it exists.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    const res = await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}`, headers: { cookie: mallory.cookie },
    });
    assert.equal(res.statusCode, 404);
  });

  test('an unknown chat id also gets 404', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'GET', url: `/api/chats/${randomUUID()}`, headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('sequence allocation', () => {
  test('allocates strictly increasing numbers', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    const a = await harness.store.chats.allocateSeq(chat.id);
    const b = await harness.store.chats.allocateSeq(chat.id);
    assert.equal(b, a + 1);
  });

  test('concurrent allocation never repeats a number', async () => {
    // Two senders at once must not both get seq 5 — the unique index on
    // (chat_id, seq) would reject one of their messages outright.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openPrivateChat(alice, bob.id);

    const seqs = await Promise.all(
      Array.from({ length: 20 }, () => harness.store.chats.allocateSeq(chat.id))
    );

    assert.equal(new Set(seqs).size, 20, 'every allocation is unique');
    assert.deepEqual([...seqs].sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
