import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import { createTestApp, registerUser, truncateAll, testConfig } from './helpers/harness.js';

let harness;
let app;
let baseUrl;

before(async () => {
  harness = await createTestApp();
  app = harness.app;
  // A real listening socket is required: fastify.inject() cannot perform a
  // WebSocket upgrade. Port 0 lets the OS pick a free port.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await closeAllSockets();
  await harness.close();
});

beforeEach(async () => {
  await closeAllSockets();
  await truncateAll(harness.store);
  await harness.store.redis.flushdb();
});

afterEach(async () => {
  await closeAllSockets();
});

// ─── helpers ────────────────────────────────────────────────

// Every socket is tracked so a failing assertion cannot leave one open —
// an orphaned socket keeps the server alive and hangs the whole test file.
const openSockets = new Set();

function connect(cookie, { origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const ws = new WebSocket(baseUrl, { headers });
  openSockets.add(ws);
  ws.once('close', () => openSockets.delete(ws));
  return ws;
}

// Terminating a socket is not enough: the server clears its per-connection
// heartbeat interval in the 'close' handler, so closing the app before those
// handlers run leaves live timers and the test process never exits.
async function closeAllSockets() {
  const pending = [...openSockets].map((ws) => {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise((resolve) => ws.once('close', resolve));
    try { ws.terminate(); } catch { return Promise.resolve(); }
    return closed;
  });

  await Promise.all(pending);
  openSockets.clear();
  // Yield once more so the server-side 'close' listeners actually run.
  await new Promise((resolve) => setImmediate(resolve));
}

function nextMessage(ws, { match, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for message${match ? ` matching ${match}` : ''}`));
    }, timeout);

    function onMessage(raw) {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      // Heartbeats are noise for every assertion in this file.
      if (parsed.type === 'heartbeat' || parsed.type === 'ping') return;
      if (match && parsed.type !== match) return;
      cleanup();
      resolve(parsed);
    }
    function onClose(code) { cleanup(); reject(new Error(`socket closed: ${code}`)); }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function opened(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function closedWith(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function authedSocket(user) {
  const ws = connect(user.cookie);
  await opened(ws);
  await nextMessage(ws, { match: 'auth_ok' });
  return ws;
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ─── tests ──────────────────────────────────────────────────

describe('WebSocket authentication', () => {
  test('authenticates from the upgrade cookie', async () => {
    const alice = await registerUser(app);
    const ws = connect(alice.cookie);
    await opened(ws);

    const msg = await nextMessage(ws, { match: 'auth_ok' });
    assert.equal(msg.userId, alice.id);
    ws.close();
  });

  test('rejects a disallowed Origin with a clean 4003 close', async () => {
    // CSWSH protection. This used to be dead code: CORS answered a bad-Origin
    // upgrade with a 500 before this handler ran, so the connection was
    // refused but the 4003 path never executed — and the refused upgrade left
    // a half-open socket that blocked graceful shutdown. Upgrades now bypass
    // the CORS layer so this check is authoritative.
    const alice = await registerUser(app);
    const ws = connect(alice.cookie, { origin: 'https://evil.example' });

    await opened(ws);
    const code = await closedWith(ws);

    assert.equal(code, 4003, 'the connection must be closed by the ws-level origin check');
  });

  test('a disallowed Origin never authenticates, even with a valid cookie', async () => {
    // The property that actually matters: a hostile page holding a valid
    // session cookie must not get a working socket.
    const alice = await registerUser(app);
    const ws = connect(alice.cookie, { origin: 'https://evil.example' });
    await opened(ws);

    await assert.rejects(nextMessage(ws, { match: 'auth_ok', timeout: 600 }));
  });

  test('an allowed Origin is accepted', async () => {
    const alice = await registerUser(app);
    const ws = connect(alice.cookie, { origin: testConfig.clientOrigin });
    await opened(ws);

    const msg = await nextMessage(ws, { match: 'auth_ok' });
    assert.equal(msg.userId, alice.id);
    ws.close();
  });

  test('does not authenticate without a cookie', async () => {
    const ws = connect(null);
    await opened(ws);

    await assert.rejects(
      nextMessage(ws, { match: 'auth_ok', timeout: 600 }),
      'an unauthenticated socket must never receive auth_ok'
    );
    ws.close();
  });

  test('a forged cookie does not authenticate', async () => {
    const ws = connect('vault_session=not.a.real.jwt');
    await opened(ws);

    await assert.rejects(nextMessage(ws, { match: 'auth_ok', timeout: 600 }));
    ws.close();
  });

  test('a cookie for a destroyed session does not authenticate', async () => {
    const alice = await registerUser(app);
    await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie: alice.cookie },
    });

    const ws = connect(alice.cookie);
    await opened(ws);
    await assert.rejects(nextMessage(ws, { match: 'auth_ok', timeout: 600 }));
    ws.close();
  });
});

describe('pending queue flush on connect', () => {
  test('delivers messages queued while offline', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: {
        recipientId: bob.id,
        ciphertext: 'queued-while-offline',
        ephemeralKey: 'e',
        messageNumber: 0,
      },
    });

    // Connect exactly once: the flush happens on this connection, and
    // connecting a second time would find the queue already drained.
    const ws = connect(bob.cookie);
    await opened(ws);
    const msg = await nextMessage(ws, { match: 'message' });

    assert.equal(msg.data.ciphertext, 'queued-while-offline');
    assert.equal(msg.data.senderId, alice.id);
    ws.close();
  });

  test('a drained queue is not redelivered on reconnect', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: {
        recipientId: bob.id, ciphertext: 'deliver-once',
        ephemeralKey: 'e', messageNumber: 0,
      },
    });

    const first = connect(bob.cookie);
    await opened(first);
    await nextMessage(first, { match: 'message' });
    first.close();

    const second = connect(bob.cookie);
    await opened(second);
    await assert.rejects(
      nextMessage(second, { match: 'message', timeout: 600 }),
      'an already-delivered message must not be replayed'
    );
    second.close();
  });
});

describe('cloud chat delivery', () => {
  test('a cloud message reaches the peer and the sender’s other devices', async () => {
    // Multi-device sync is the headline reason cloud mode exists: a device
    // that holds no keys still receives the message. This asserts the fanout
    // actually includes the sender's own other connections, not just the peer.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    const aliceLaptop = await authedSocket(alice);
    const alicePhone  = await authedSocket(alice);   // second device
    const bobWs       = await authedSocket(bob);

    const toPhone = nextMessage(alicePhone, { match: 'message' });
    const toBob   = nextMessage(bobWs, { match: 'message' });

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: alice.cookie }, payload: { body: 'synced across devices' },
    });

    const phoneMsg = await toPhone;
    const bobMsg = await toBob;

    assert.equal(phoneMsg.data.body, 'synced across devices', 'alice\'s other device receives it');
    assert.equal(bobMsg.data.body, 'synced across devices', 'the peer receives it');
    assert.equal(bobMsg.data.mode, 'cloud');
    assert.ok(bobMsg.data.expiresAt, 'and it still carries an expiry');

    aliceLaptop.close(); alicePhone.close(); bobWs.close();
  });

  test('a non-member never receives cloud traffic', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    const malloryWs = await authedSocket(mallory);
    const leaked = nextMessage(malloryWs, { match: 'message', timeout: 600 });

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: alice.cookie }, payload: { body: 'members only' },
    });

    await assert.rejects(leaked, 'an outsider must receive nothing');
    malloryWs.close();
  });
});

describe('typing indicator relay', () => {
  test('reaches the intended recipient tagged with the sender', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const incoming = nextMessage(bobWs, { match: 'typing' });
    send(aliceWs, { type: 'typing', recipientId: bob.id });

    const msg = await incoming;
    assert.equal(msg.senderId, alice.id, 'senderId is set by the server, not the client');

    aliceWs.close();
    bobWs.close();
  });

  test('is not broadcast to unrelated users', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);
    const carolWs = await authedSocket(carol);

    const toBob = nextMessage(bobWs, { match: 'typing' });
    const toCarol = nextMessage(carolWs, { match: 'typing', timeout: 600 });

    send(aliceWs, { type: 'typing', recipientId: bob.id });

    await toBob;
    await assert.rejects(toCarol, 'carol must not see typing meant for bob');

    aliceWs.close(); bobWs.close(); carolWs.close();
  });
});

describe('read and delivered acknowledgements', () => {
  test('a read receipt reaches the original sender', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: { recipientId: bob.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });
    const messageId = sent.json().id;

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const receipt = nextMessage(aliceWs, { match: 'read' });
    send(bobWs, { type: 'read', messageId });

    const msg = await receipt;
    assert.equal(msg.messageId, messageId);
    assert.equal(msg.recipientId, bob.id);

    aliceWs.close(); bobWs.close();
  });

  test('a third party cannot mark someone else’s message read', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: { recipientId: bob.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });
    const messageId = sent.json().id;

    const aliceWs = await authedSocket(alice);
    const malloryWs = await authedSocket(mallory);

    const receipt = nextMessage(aliceWs, { match: 'read', timeout: 600 });
    send(malloryWs, { type: 'read', messageId });

    await assert.rejects(receipt, 'only the actual recipient may ack a message');

    aliceWs.close(); malloryWs.close();
  });
});

describe('WebRTC call signalling', () => {
  test('an invite is relayed to the callee', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const incoming = nextMessage(bobWs, { match: 'call_invite' });
    send(aliceWs, { type: 'call_invite', recipientId: bob.id, callType: 'audio' });

    const msg = await incoming;
    assert.equal(msg.senderId, alice.id);

    aliceWs.close(); bobWs.close();
  });

  test('call_accept without a matching invite is rejected', async () => {
    // Otherwise any authenticated user could accept a call "from" anyone and
    // hijack or overwrite that person's active call mapping.
    const alice = await registerUser(app);
    const mallory = await registerUser(app);

    const malloryWs = await authedSocket(mallory);

    const err = nextMessage(malloryWs, { match: 'error' });
    send(malloryWs, { type: 'call_accept', recipientId: alice.id });

    const msg = await err;
    assert.match(msg.message, /no pending call invite/i);

    malloryWs.close();
  });

  test('call_accept succeeds only for the invited party', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const invited = nextMessage(bobWs, { match: 'call_invite' });
    send(aliceWs, { type: 'call_invite', recipientId: bob.id });
    await invited;

    const accepted = nextMessage(aliceWs, { match: 'call_accept' });
    send(bobWs, { type: 'call_accept', recipientId: alice.id });
    await accepted;

    assert.equal(harness.store.getActiveCall(bob.id), alice.id);

    aliceWs.close(); bobWs.close();
  });

  test('SDP relay is refused without an established call', async () => {
    const alice = await registerUser(app);
    const mallory = await registerUser(app);

    const malloryWs = await authedSocket(mallory);

    const err = nextMessage(malloryWs, { match: 'error' });
    send(malloryWs, { type: 'webrtc_sdp', recipientId: alice.id, sdp: 'fake' });

    const msg = await err;
    assert.match(msg.message, /no active call session/i);

    malloryWs.close();
  });

  test('SDP relay works once a call is established', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const invited = nextMessage(bobWs, { match: 'call_invite' });
    send(aliceWs, { type: 'call_invite', recipientId: bob.id });
    await invited;

    const accepted = nextMessage(aliceWs, { match: 'call_accept' });
    send(bobWs, { type: 'call_accept', recipientId: alice.id });
    await accepted;

    const relayed = nextMessage(aliceWs, { match: 'webrtc_sdp' });
    send(bobWs, { type: 'webrtc_sdp', recipientId: alice.id, sdp: 'offer-blob' });

    const msg = await relayed;
    assert.equal(msg.sdp, 'offer-blob');
    assert.equal(msg.senderId, bob.id);

    aliceWs.close(); bobWs.close();
  });

  test('a signalling event to a non-existent user is refused', async () => {
    const alice = await registerUser(app);
    const aliceWs = await authedSocket(alice);

    const err = nextMessage(aliceWs, { match: 'error' });
    send(aliceWs, { type: 'call_invite', recipientId: randomUUID() });

    const msg = await err;
    assert.match(msg.message, /invalid call recipient/i);

    aliceWs.close();
  });

  test('a non-uuid recipient is refused', async () => {
    const alice = await registerUser(app);
    const aliceWs = await authedSocket(alice);

    const err = nextMessage(aliceWs, { match: 'error' });
    send(aliceWs, { type: 'call_invite', recipientId: 'not-a-uuid' });

    const msg = await err;
    assert.match(msg.message, /invalid call recipient/i);

    aliceWs.close();
  });

  test('hangup clears the active call mapping', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const aliceWs = await authedSocket(alice);
    const bobWs = await authedSocket(bob);

    const invited = nextMessage(bobWs, { match: 'call_invite' });
    send(aliceWs, { type: 'call_invite', recipientId: bob.id });
    await invited;

    const accepted = nextMessage(aliceWs, { match: 'call_accept' });
    send(bobWs, { type: 'call_accept', recipientId: alice.id });
    await accepted;

    const hungUp = nextMessage(aliceWs, { match: 'call_hangup' });
    send(bobWs, { type: 'call_hangup', recipientId: alice.id });
    await hungUp;

    assert.equal(harness.store.getActiveCall(bob.id), undefined);

    aliceWs.close(); bobWs.close();
  });
});
