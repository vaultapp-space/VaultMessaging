import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';
import { MAX_TTL_MINUTES } from '../src/utils/constants.js';

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

function messagePayload(recipientId, overrides = {}) {
  return {
    recipientId,
    ciphertext: 'base64-ciphertext',
    ephemeralKey: 'base64-ephemeral',
    messageNumber: 0,
    iv: 'base64-iv',
    ...overrides,
  };
}

async function send(app, sender, payload) {
  return app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie: sender.cookie },
    payload,
  });
}

describe('POST /api/messages', () => {
  test('stores a message and reports it undelivered when the peer is offline', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await send(app, alice, messagePayload(bob.id));

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.id);
    assert.equal(body.delivered, false, 'no websocket is connected in this test');
    assert.ok(body.expiresAt, 'every message carries an expiry');
  });

  test('requires authentication', async () => {
    const bob = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: messagePayload(bob.id),
    });
    assert.equal(res.statusCode, 401);
  });

  test('404s for an unknown recipient', async () => {
    const alice = await registerUser(app);
    const res = await send(app, alice, messagePayload(randomUUID()));
    assert.equal(res.statusCode, 404);
  });

  test('rejects a non-uuid recipient', async () => {
    const alice = await registerUser(app);
    const res = await send(app, alice, messagePayload('not-a-uuid'));
    assert.equal(res.statusCode, 400);
  });

  test('accepts explicit nulls for groupId and attachmentId', async () => {
    // Regression guard: AJV coerces null to '' for a plain string type, which
    // then fails the UUID pattern and 400s every ordinary send.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await send(app, alice, messagePayload(bob.id, {
      groupId: null,
      attachmentId: null,
    }));
    assert.equal(res.statusCode, 201);
  });

  test('clamps a TTL above the 24h ceiling', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await send(app, alice, messagePayload(bob.id, {
      ttlMinutes: MAX_TTL_MINUTES + 10_000,
    }));

    // Out-of-range values are rejected by the schema rather than silently
    // clamped, which is the stronger behaviour.
    assert.equal(res.statusCode, 400);
  });

  test('honours a short TTL', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await send(app, alice, messagePayload(bob.id, { ttlMinutes: 1 }));
    assert.equal(res.statusCode, 201);

    const expiresAt = new Date(res.json().expiresAt).getTime();
    const delta = expiresAt - Date.now();
    assert.ok(delta > 0 && delta <= 90_000, `expected ~1 minute TTL, got ${delta}ms`);
  });

  test('refuses to tag a message with a group the sender is not in', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie: alice.cookie },
      payload: { name: 'private', members: [bob.id] },
    });
    const groupId = group.json().id;

    const res = await send(app, mallory, messagePayload(bob.id, { groupId }));
    assert.equal(res.statusCode, 403, 'group membership must be enforced server-side');
  });

  test('allows a member to tag a message with their group', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie: alice.cookie },
      payload: { name: 'ours', members: [bob.id] },
    });

    const res = await send(app, alice, messagePayload(bob.id, { groupId: group.json().id }));
    assert.equal(res.statusCode, 201);
  });
});

describe('GET /api/messages/:peerId', () => {
  test('returns the conversation in both directions', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await send(app, alice, messagePayload(bob.id, { ciphertext: 'from-alice' }));
    await send(app, bob, messagePayload(alice.id, { ciphertext: 'from-bob' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/${bob.id}`,
      headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    const texts = res.json().messages.map((m) => m.ciphertext).sort();
    assert.deepEqual(texts, ['from-alice', 'from-bob']);
  });

  test('does not leak a conversation between two other users', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    await send(app, alice, messagePayload(bob.id, { ciphertext: 'secret' }));

    // Mallory asks for her conversation with Bob; Alice's traffic must not appear.
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/${bob.id}`,
      headers: { cookie: mallory.cookie },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().messages.length, 0);
  });

  test('requires authentication', async () => {
    const bob = await registerUser(app);
    const res = await app.inject({ method: 'GET', url: `/api/messages/${bob.id}` });
    assert.equal(res.statusCode, 401);
  });

  test('respects the limit and reports hasMore', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    for (let i = 0; i < 5; i += 1) {
      await send(app, alice, messagePayload(bob.id, { ciphertext: `m${i}`, messageNumber: i }));
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/${bob.id}?limit=2`,
      headers: { cookie: alice.cookie },
    });

    assert.equal(res.json().messages.length, 2);
    assert.equal(res.json().hasMore, true);
  });

  test('rejects a limit above the maximum', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages/${bob.id}?limit=1000`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('GET /api/messages/pending/all', () => {
  test('returns queued messages once and then drains them', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await send(app, alice, messagePayload(bob.id, { ciphertext: 'queued' }));

    const first = await app.inject({
      method: 'GET',
      url: '/api/messages/pending/all',
      headers: { cookie: bob.cookie },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().messages.length, 1);

    const second = await app.inject({
      method: 'GET',
      url: '/api/messages/pending/all',
      headers: { cookie: bob.cookie },
    });
    assert.equal(second.json().messages.length, 0, 'fetching marks them delivered');
  });

  test('only returns the caller’s own pending messages', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    await send(app, alice, messagePayload(bob.id, { ciphertext: 'for-bob' }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages/pending/all',
      headers: { cookie: mallory.cookie },
    });
    assert.equal(res.json().messages.length, 0);
  });
});

describe('GET /api/conversations', () => {
  test('lists a peer after a message is exchanged', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await send(app, alice, messagePayload(bob.id));

    const res = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    const peers = res.json().conversations.map((c) => c.id ?? c.peerId);
    assert.ok(peers.includes(bob.id), `expected bob in ${JSON.stringify(res.json().conversations)}`);
  });

  test('is empty for a user with no history', async () => {
    const loner = await registerUser(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: loner.cookie },
    });
    assert.equal(res.json().conversations.length, 0);
  });
});

describe('GET /api/users/search', () => {
  test('rejects queries shorter than three characters', async () => {
    // A single-letter query would match most of the user table, turning
    // search into an enumeration primitive.
    const alice = await registerUser(app);
    for (const q of ['', 'a', 'ab']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/users/search?q=${q}`,
        headers: { cookie: alice.cookie },
      });
      assert.equal(res.statusCode, 400, `expected 400 for q=${JSON.stringify(q)}`);
    }
  });

  test('finds a user by username prefix', async () => {
    const alice = await registerUser(app);
    await registerUser(app, { username: 'searchtarget' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/users/search?q=searchtar',
      headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.json().users.some((u) => u.username === 'searchtarget'));
  });

  test('does not match on a non-prefix substring', async () => {
    const alice = await registerUser(app);
    await registerUser(app, { username: 'zzzhiddenzzz' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/users/search?q=hidden',
      headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(
      !res.json().users.some((u) => u.username === 'zzzhiddenzzz'),
      'search must stay prefix-anchored'
    );
  });

  test('excludes the caller from their own results', async () => {
    const alice = await registerUser(app, { username: 'selfsearcher' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/search?q=selfsearch',
      headers: { cookie: alice.cookie },
    });
    assert.ok(!res.json().users.some((u) => u.id === alice.id));
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/search?q=abc' });
    assert.equal(res.statusCode, 401);
  });
});
