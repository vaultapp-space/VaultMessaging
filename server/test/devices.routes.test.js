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

// A second sign-in for an existing account, which is what a second device
// actually is. Returns the cookie plus the device id the server issued.
async function signInAgain(username, password, deviceName = 'second device') {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password, deviceName, platform: 'test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.headers['set-cookie'];
  return {
    cookie: Array.isArray(cookie) ? cookie[0].split(';')[0] : cookie.split(';')[0],
    deviceId: res.json().deviceId,
  };
}

function listDevices(user) {
  return app.inject({
    method: 'GET', url: '/api/devices', headers: { cookie: user.cookie },
  });
}

function revokeDevice(user, deviceId) {
  return app.inject({
    method: 'DELETE', url: `/api/devices/${deviceId}`, headers: { cookie: user.cookie },
  });
}

function updatesSince(user, pts) {
  return app.inject({
    method: 'GET', url: `/api/updates?pts=${pts}`, headers: { cookie: user.cookie },
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

function send(user, chatId, payload) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload,
  });
}

// ============================================================
// Devices
// ============================================================

describe('devices', () => {
  test('signing in registers a device that shows up in the list', async () => {
    const alice = await registerUser(app);

    const { devices } = (await listDevices(alice)).json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].current, true, 'the caller can tell which row is itself');
  });

  test('a second sign-in is a second device, not a replacement', async () => {
    // The failure this guards against is treating a login as "the" session:
    // signing in on a laptop must not silently sign out the phone.
    const alice = await registerUser(app);
    await signInAgain(alice.username, alice.password);

    const { devices } = (await listDevices(alice)).json();
    assert.equal(devices.length, 2);
    assert.equal(devices.filter((d) => d.current).length, 1);
  });

  test('revoking a device stops its token working immediately', async () => {
    // The whole point. A 24h JWT would otherwise keep a lost phone working
    // for up to a day after the owner believed they had secured the account.
    const alice = await registerUser(app);
    const second = await signInAgain(alice.username, alice.password);

    const before = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie },
    });
    assert.equal(before.statusCode, 200);

    const revoked = await revokeDevice(alice, second.deviceId);
    assert.equal(revoked.statusCode, 200, revoked.body);

    const after = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie },
    });
    assert.equal(after.statusCode, 401, 'the revoked token must stop authenticating');
  });

  test('revoking one device leaves the others signed in', async () => {
    const alice = await registerUser(app);
    const second = await signInAgain(alice.username, alice.password);

    await revokeDevice(alice, second.deviceId);

    const stillFine = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: alice.cookie },
    });
    assert.equal(stillFine.statusCode, 200);
  });

  test('a revoked device disappears from the list', async () => {
    const alice = await registerUser(app);
    const second = await signInAgain(alice.username, alice.password);
    await revokeDevice(alice, second.deviceId);

    const { devices } = (await listDevices(alice)).json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].current, true);
  });

  test('one account cannot revoke another account\'s device', async () => {
    // Ownership is enforced inside the UPDATE rather than by a prior check,
    // because a read-then-write here is a race with real consequences.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceDevices = (await listDevices(alice)).json().devices;

    const res = await revokeDevice(bob, aliceDevices[0].id);
    assert.equal(res.statusCode, 404, 'and it must not leak that the device exists');

    const stillFine = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: alice.cookie },
    });
    assert.equal(stillFine.statusCode, 200);
  });

  test('an unauthenticated caller cannot list devices', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/devices' });
    assert.equal(res.statusCode, 401);
  });
});

// ============================================================
// Catch-up (pts)
// ============================================================
// This replaces the per-message `delivered` boolean, which cannot survive
// more than one device: with two, "delivered" has no single answer.

describe('catching up', () => {
  test('a message a device missed comes back in the update log', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    // Bob's second device notes where it is, then misses a message.
    const start = (await updatesSince(bob, 0)).json().pts;

    await send(alice, chat.id, { body: 'while you were out' });

    const caught = (await updatesSince(bob, start)).json();
    assert.equal(caught.tooLong, false);
    assert.equal(caught.updates.length, 1);
    assert.equal(caught.updates[0].kind, 'message');
    assert.equal(caught.updates[0].body, 'while you were out');
  });

  test('catching up twice does not replay what was already applied', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'one' });
    const first = (await updatesSince(bob, 0)).json();
    assert.equal(first.updates.length, 1);

    const second = (await updatesSince(bob, first.pts)).json();
    assert.equal(second.updates.length, 0, 'an idle device gets nothing');
    assert.equal(second.pts, first.pts);
  });

  test('updates arrive in order', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'first' });
    await send(alice, chat.id, { body: 'second' });
    await send(alice, chat.id, { body: 'third' });

    const { updates } = (await updatesSince(bob, 0)).json();
    assert.deepEqual(updates.map((u) => u.body), ['first', 'second', 'third']);
    // Monotonic, which is what lets a client store one number instead of a set.
    for (let i = 1; i < updates.length; i++) {
      assert.ok(updates[i].pts > updates[i - 1].pts);
    }
  });

  test('a gap the log can no longer serve reports tooLong instead of lying', async () => {
    // Reaped rows mean replay cannot bring a client up to date. Returning a
    // partial replay would leave it silently missing messages, which is far
    // worse than telling it to refetch.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'this will be reaped' });
    await harness.store.pool.query(
      `UPDATE user_updates SET expires_at = now() - interval '1 hour'`
    );
    await harness.store.reap();

    const caught = (await updatesSince(bob, 0)).json();
    assert.equal(caught.tooLong, true);
    assert.equal(caught.updates.length, 0);
  });

  test('a secret chat is never written to the update log', async () => {
    // The log stores plaintext. Writing a secret chat into it would hand the
    // server exactly the content that mode exists to withhold — and it would
    // survive in a second place after the message itself was gone.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id, 'secret');

    const res = await send(alice, chat.id, { body: 'should be refused' });
    assert.equal(res.statusCode, 400, 'cloud sends are refused for a secret chat');

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates`
    );
    assert.equal(rows[0].n, 0);
  });

  test('the update log expires with its messages', async () => {
    // The standing 24h guard, applied to the one table most likely to drift
    // into being an archive: it holds a copy of every message body.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'ephemeral' });

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates WHERE expires_at IS NULL`
    );
    assert.equal(rows[0].n, 0, 'no update row may be exempt from expiry');

    const { rows: horizon } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates
        WHERE expires_at > now() + interval '24 hours'`
    );
    assert.equal(horizon[0].n, 0, 'and none may outlive the ceiling');
  });

  test('the reaper clears expired updates', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'gone tomorrow' });
    await harness.store.pool.query(
      `UPDATE user_updates SET expires_at = now() - interval '1 second'`
    );
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates`
    );
    assert.equal(rows[0].n, 0);
  });

  test('one user cannot read another user\'s updates', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'not for carol' });

    const { updates } = (await updatesSince(carol, 0)).json();
    assert.equal(updates.length, 0);
  });
});
