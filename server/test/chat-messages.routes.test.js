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

async function openChat(user, peerId, mode = 'cloud') {
  const res = await app.inject({
    method: 'POST', url: '/api/chats/private',
    headers: { cookie: user.cookie }, payload: { peerId, mode },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function send(user, chatId, payload) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload,
  });
}

function fetchMessages(user, chatId, query = '') {
  return app.inject({
    method: 'GET', url: `/api/chats/${chatId}/messages${query}`,
    headers: { cookie: user.cookie },
  });
}

describe('POST /api/chats/:chatId/messages', () => {
  test('stores a cloud message and returns it', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await send(alice, chat.id, { body: 'hello cloud' });

    assert.equal(res.statusCode, 201);
    const msg = res.json();
    assert.equal(msg.body, 'hello cloud');
    assert.equal(msg.seq, 1);
    assert.equal(msg.mode, 'cloud');
    assert.ok(msg.expiresAt, 'every message carries an expiry');
  });

  test('allocates strictly increasing sequence numbers', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const first = await send(alice, chat.id, { body: 'one' });
    const second = await send(bob, chat.id, { body: 'two' });

    assert.equal(first.json().seq, 1);
    assert.equal(second.json().seq, 2, 'seq is per chat, not per sender');
  });

  test('concurrent sends never collide on seq', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => send(alice, chat.id, { body: `m${i}` }))
    );

    const seqs = results.map((r) => r.json().seq);
    assert.equal(new Set(seqs).size, 10, 'every message gets its own seq');
  });

  test('carries entities, media and a reply reference', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'first' });
    const res = await send(alice, chat.id, {
      body: 'bold reply',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
      media: { id: 'file-1', mimeType: 'image/png' },
      replyToSeq: 1,
    });

    assert.equal(res.statusCode, 201);
    const stored = fetchOne(await fetchMessages(alice, chat.id), 2);
    assert.deepEqual(stored.entities, [{ type: 'bold', offset: 0, length: 4 }]);
    assert.equal(stored.media.id, 'file-1');
    assert.equal(stored.replyToSeq, 1);
  });

  test('refuses to store plaintext in a secret chat', async () => {
    // The worst possible failure: a client bug handing the server plaintext
    // for a conversation the user believes is end-to-end encrypted.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const secret = await openChat(alice, bob.id, 'secret');

    const res = await send(alice, secret.id, { body: 'should never be stored' });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /end-to-end encrypted/i);

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND body IS NOT NULL`,
      [secret.id]
    );
    assert.equal(rows[0].n, 0, 'nothing was written');
  });

  test('a non-member cannot send', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await send(mallory, chat.id, { body: 'intrusion' });
    assert.equal(res.statusCode, 404);
  });

  test('requires authentication', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`, payload: { body: 'x' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('rejects an empty message', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    assert.equal((await send(alice, chat.id, {})).statusCode, 400);
  });

  test('404s for an unknown chat', async () => {
    const alice = await registerUser(app);
    const res = await send(alice, randomUUID(), { body: 'x' });
    assert.equal(res.statusCode, 404);
  });

  test('a retried send is idempotent', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const clientRandomId = 987654321;
    const first = await send(alice, chat.id, { body: 'once', clientRandomId });
    const retry = await send(alice, chat.id, { body: 'once', clientRandomId });

    assert.equal(first.json().id, retry.json().id, 'the retry resolves to the original');

    const listed = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(listed.length, 1, 'no duplicate was created');
  });

  test('increments the recipient unread count but not the sender’s', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'unread for bob' });

    const bobChats = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: bob.cookie },
    })).json().chats;
    const aliceChats = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: alice.cookie },
    })).json().chats;

    assert.equal(bobChats.find((c) => c.id === chat.id).unreadCount, 1);
    assert.equal(aliceChats.find((c) => c.id === chat.id).unreadCount, 0);
  });
});

describe('replies', () => {
  test('stores and returns the reply reference', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const original = await send(alice, chat.id, { body: 'the question' });
    const reply = await send(bob, chat.id, { body: 'the answer', replyToSeq: original.json().seq });

    assert.equal(reply.statusCode, 201);
    const fetched = (await fetchMessages(alice, chat.id)).json().messages;
    const stored = fetched.find((m) => m.body === 'the answer');
    assert.equal(stored.replyToSeq, original.json().seq);
  });

  test('a reply survives the message it answers', async () => {
    // Messages are reaped individually, so a reply can outlive its original.
    // The reference must remain rather than the reply vanishing with it.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const original = await send(alice, chat.id, { body: 'ephemeral question', ttlSeconds: 60 });
    await send(bob, chat.id, { body: 'durable answer', replyToSeq: original.json().seq });

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
        WHERE chat_id = $1 AND seq = $2`,
      [chat.id, original.json().seq]
    );
    await harness.store.reap();

    const remaining = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].body, 'durable answer');
    assert.equal(remaining[0].replyToSeq, original.json().seq,
      'the reference is kept so the client can say the original expired');
  });

  test('rejects a reply to seq 0 or below', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await send(alice, chat.id, { body: 'bad', replyToSeq: 0 });
    assert.equal(res.statusCode, 400);
  });

  test('a message without a reply reports null', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    await send(alice, chat.id, { body: 'standalone' });

    const [msg] = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(msg.replyToSeq, null);
  });
});

describe('editing', () => {
  function edit(user, chatId, seq, body) {
    return app.inject({
      method: 'PATCH', url: `/api/chats/${chatId}/messages/${seq}`,
      headers: { cookie: user.cookie }, payload: { body },
    });
  }

  test('the author can rewrite their own message', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'teh original' })).json();

    const res = await edit(alice, chat.id, msg.seq, 'the original');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().body, 'the original');
    assert.ok(res.json().editedAt, 'the edit is stamped');
  });

  test('the edit is what subsequent readers see', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'before' })).json();

    await edit(alice, chat.id, msg.seq, 'after');

    const fetched = (await fetchMessages(bob, chat.id)).json().messages;
    assert.equal(fetched[0].body, 'after');
    assert.ok(fetched[0].editedAt);
  });

  test('a message that was never edited has no editedAt', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    await send(alice, chat.id, { body: 'untouched' });

    const [msg] = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(msg.editedAt, null);
  });

  test('another member cannot edit someone else’s message', async () => {
    // The whole point of an edit marker is that it means the *author*
    // changed their words. A member rewriting a peer's message would make
    // the transcript untrustworthy.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'alice said this' })).json();

    const res = await edit(bob, chat.id, msg.seq, 'bob put words in her mouth');

    assert.equal(res.statusCode, 403);

    const fetched = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(fetched[0].body, 'alice said this', 'unchanged');
  });

  test('a non-member gets 404, not 403', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'private' })).json();

    assert.equal((await edit(mallory, chat.id, msg.seq, 'x')).statusCode, 404);
  });

  test('requires authentication', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'x' })).json();

    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/messages/${msg.seq}`,
      payload: { body: 'y' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('404s for a message that does not exist', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    assert.equal((await edit(alice, chat.id, 999, 'x')).statusCode, 404);
  });

  test('rejects an empty body', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'x' })).json();

    assert.equal((await edit(alice, chat.id, msg.seq, '')).statusCode, 400);
  });

  test('a secret chat refuses server-side edits', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const secret = await openChat(alice, bob.id, 'secret');

    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${secret.id}/messages/1`,
      headers: { cookie: alice.cookie }, payload: { body: 'nope' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /end-to-end encrypted/i);
  });

  test('editing does not extend the message lifetime', async () => {
    // An edit must not become a way to keep a message alive past its expiry.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    const msg = (await send(alice, chat.id, { body: 'original', ttlSeconds: 120 })).json();

    await edit(alice, chat.id, msg.seq, 'edited');

    const { rows } = await harness.store.pool.query(
      `SELECT expires_at FROM messages WHERE chat_id = $1 AND seq = $2`, [chat.id, msg.seq]
    );
    assert.equal(
      new Date(rows[0].expires_at).getTime(),
      new Date(msg.expiresAt).getTime(),
      'expiry is untouched by an edit'
    );
  });
});

describe('the 24h ceiling on cloud messages', () => {
  test('a requested TTL beyond the ceiling is clamped, not honoured', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await send(alice, chat.id, { body: 'forever?', ttlSeconds: 60 * 60 * 24 * 30 });

    assert.equal(res.statusCode, 201);
    const lifetime = new Date(res.json().expiresAt) - Date.now();
    assert.ok(lifetime <= 24 * 60 * 60 * 1000 + 5000, `expected <= 24h, got ${lifetime}ms`);
  });

  test('a shorter TTL is honoured', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await send(alice, chat.id, { body: 'brief', ttlSeconds: 60 });
    const lifetime = new Date(res.json().expiresAt) - Date.now();
    assert.ok(lifetime > 0 && lifetime <= 90_000, `expected ~1 minute, got ${lifetime}ms`);
  });

  test('a per-chat default shortens but cannot extend', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await harness.store.pool.query(
      `UPDATE chats SET default_ttl_secs = 120 WHERE id = $1`, [chat.id]
    );

    const res = await send(alice, chat.id, { body: 'uses chat default' });
    const lifetime = new Date(res.json().expiresAt) - Date.now();
    assert.ok(lifetime <= 130_000, `chat default must apply, got ${lifetime}ms`);
  });

  test('no cloud message is ever stored without an expiry', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'a' });
    await send(alice, chat.id, { body: 'b', ttlSeconds: 3600 });

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS immortal FROM messages WHERE expires_at IS NULL`
    );
    assert.equal(rows[0].immortal, 0);
  });
});

describe('GET /api/chats/:chatId/messages', () => {
  test('returns messages oldest-first for rendering', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    for (const body of ['one', 'two', 'three']) {
      await send(alice, chat.id, { body });
    }

    const res = await fetchMessages(alice, chat.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages.map((m) => m.body), ['one', 'two', 'three']);
  });

  test('states the retention window explicitly', async () => {
    // So a client never has to infer why history stops.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await fetchMessages(alice, chat.id);
    assert.equal(res.json().retentionSeconds, 86400);
  });

  test('pages backwards with before', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    for (let i = 1; i <= 5; i += 1) await send(alice, chat.id, { body: `m${i}` });

    const page = await fetchMessages(alice, chat.id, '?limit=2&before=4');
    assert.deepEqual(page.json().messages.map((m) => m.seq), [2, 3]);
  });

  test('reports hasMore when the page is full', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    for (let i = 0; i < 4; i += 1) await send(alice, chat.id, { body: `m${i}` });

    assert.equal((await fetchMessages(alice, chat.id, '?limit=2')).json().hasMore, true);
    assert.equal((await fetchMessages(alice, chat.id, '?limit=50')).json().hasMore, false);
  });

  test('a non-member cannot read the chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const chat = await openChat(alice, bob.id);
    await send(alice, chat.id, { body: 'private' });

    const res = await fetchMessages(mallory, chat.id);
    assert.equal(res.statusCode, 404);
  });

  test('expired messages are gone from the chat but the chat remains', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'ephemeral', ttlSeconds: 1 });
    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second' WHERE chat_id = $1`, [chat.id]
    );
    await harness.store.reap();

    assert.equal((await fetchMessages(alice, chat.id)).json().messages.length, 0);

    const chats = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: alice.cookie },
    })).json().chats;
    assert.ok(chats.some((c) => c.id === chat.id), 'the conversation survives its contents');
  });
});

function fetchOne(res, seq) {
  return res.json().messages.find((m) => m.seq === seq);
}
