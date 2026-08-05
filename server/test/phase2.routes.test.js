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

async function send(user, chatId, body) {
  const res = await app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie }, payload: { body },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function fetchMessages(user, chatId) {
  return app.inject({
    method: 'GET', url: `/api/chats/${chatId}/messages`, headers: { cookie: user.cookie },
  });
}

async function pair(mode = 'cloud') {
  const alice = await registerUser(app);
  const bob = await registerUser(app);
  const chat = await openChat(alice, bob.id, mode);
  return { alice, bob, chat };
}

// ============================================================

describe('deleting messages', () => {
  test('delete for me hides it from the caller only', async () => {
    const { alice, bob, chat } = await pair();
    const msg = await send(alice, chat.id, 'only bob should still see this');

    const res = await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scope, 'me');

    const hidden = await harness.store.phase2.hiddenSeqsFor(chat.id, bob.id);
    assert.deepEqual(hidden, [msg.seq]);

    // Alice's copy is untouched — that is the whole distinction.
    const aliceView = (await fetchMessages(alice, chat.id)).json().messages;
    assert.equal(aliceView.length, 1);
  });

  test('delete for everyone tombstones the message', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'unsend me');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/chats/${chat.id}/messages/${msg.seq}?forEveryone=true`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().scope, 'everyone');

    const { rows } = await harness.store.pool.query(
      `SELECT body, deleted_at FROM messages WHERE chat_id = $1 AND seq = $2`,
      [chat.id, msg.seq]
    );
    assert.equal(rows[0].body, null, 'content is cleared');
    assert.ok(rows[0].deleted_at, 'and tombstoned rather than removed');
  });

  test('only the author can delete for everyone', async () => {
    // Otherwise a participant could erase someone else's words for the whole
    // room, which is rewriting history rather than deleting your own message.
    const { alice, bob, chat } = await pair();
    const msg = await send(alice, chat.id, 'alice said this');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/chats/${chat.id}/messages/${msg.seq}?forEveryone=true`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 403);
  });

  test('delete-for-me is the default, so it cannot destroy by accident', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'still here');

    await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}`,
      headers: { cookie: alice.cookie },
    });

    const { rows } = await harness.store.pool.query(
      `SELECT body FROM messages WHERE chat_id = $1 AND seq = $2`, [chat.id, msg.seq]
    );
    assert.equal(rows[0].body, 'still here', 'no omission of forEveryone destroys content');
  });

  test('a secret chat refuses server-side delete-for-everyone', async () => {
    const { alice, chat } = await pair('secret');
    const res = await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/1?forEveryone=true`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a non-member cannot delete anything', async () => {
    const { alice, chat } = await pair();
    const mallory = await registerUser(app);
    const msg = await send(alice, chat.id, 'private');

    const res = await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}`,
      headers: { cookie: mallory.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('pinned messages', () => {
  test('pins and lists', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'important');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);

    const pinned = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/pinned`, headers: { cookie: alice.cookie },
    })).json().pinned;

    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].body, 'important');
  });

  test('either participant can pin — it is a shared surface', async () => {
    const { alice, bob, chat } = await pair();
    const msg = await send(alice, chat.id, 'shared');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 200);
  });

  test('unpins', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'temporary');

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: alice.cookie },
    });
    await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: alice.cookie },
    });

    const pinned = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/pinned`, headers: { cookie: alice.cookie },
    })).json().pinned;
    assert.equal(pinned.length, 0);
  });

  test('a pin dies with the message', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'pinned then expired');
    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: alice.cookie },
    });

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second' WHERE chat_id = $1`, [chat.id]
    );
    await harness.store.reap();

    const pinned = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/pinned`, headers: { cookie: alice.cookie },
    })).json().pinned;
    assert.equal(pinned.length, 0, 'pinning does not exempt a message from expiry');
  });

  test('a non-member cannot pin', async () => {
    const { alice, chat } = await pair();
    const mallory = await registerUser(app);
    const msg = await send(alice, chat.id, 'x');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages/${msg.seq}/pin`,
      headers: { cookie: mallory.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('forwarding', () => {
  test('copies a message into another chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const source = await openChat(alice, bob.id);
    const destination = await openChat(alice, carol.id);

    const msg = await send(alice, source.id, 'worth sharing');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${source.id}/forward`,
      headers: { cookie: alice.cookie },
      payload: { toChatId: destination.id, seqs: [msg.seq] },
    });

    assert.equal(res.statusCode, 201);
    const arrived = (await fetchMessages(alice, destination.id)).json().messages;
    assert.equal(arrived[0].body, 'worth sharing');
    assert.equal(arrived[0].forwarded, true);
  });

  test('forwards several messages at once', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const source = await openChat(alice, bob.id);
    const destination = await openChat(alice, carol.id);

    const a = await send(alice, source.id, 'one');
    const b = await send(alice, source.id, 'two');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${source.id}/forward`,
      headers: { cookie: alice.cookie },
      payload: { toChatId: destination.id, seqs: [a.seq, b.seq] },
    });

    assert.equal(res.json().forwarded.length, 2);
  });

  test('forwarding out of a secret chat carries no attribution', async () => {
    // Attribution would create a server-side pointer back into an encrypted
    // conversation. The content is copied; the link is not.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const secret = await openChat(alice, bob.id, 'secret');
    const destination = await openChat(alice, carol.id);

    // Seed a message directly, since a secret chat has no cloud body.
    await harness.store.pool.query(
      `INSERT INTO messages (chat_id, seq, sender_id, ciphertext, body, expires_at, sent_at)
       VALUES ($1, 1, $2, '', 'leaked?', now() + interval '1 hour', now())`,
      [secret.id, alice.id]
    );
    await harness.store.pool.query(`UPDATE chats SET last_seq = 1 WHERE id = $1`, [secret.id]);

    await app.inject({
      method: 'POST', url: `/api/chats/${secret.id}/forward`,
      headers: { cookie: alice.cookie },
      payload: { toChatId: destination.id, seqs: [1] },
    });

    const { rows } = await harness.store.pool.query(
      `SELECT fwd_from_chat FROM messages WHERE chat_id = $1`, [destination.id]
    );
    assert.equal(rows[0].fwd_from_chat, null, 'no pointer back into the secret chat');
  });

  test('cannot forward into a chat you are not in', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const dave = await registerUser(app);
    const source = await openChat(alice, bob.id);
    const theirs = await openChat(carol, dave.id);

    const msg = await send(alice, source.id, 'x');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${source.id}/forward`,
      headers: { cookie: alice.cookie },
      payload: { toChatId: theirs.id, seqs: [msg.seq] },
    });
    assert.equal(res.statusCode, 404);
  });

  test('cannot forward out of a chat you are not in', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const source = await openChat(alice, bob.id);
    const mine = await openChat(mallory, alice.id);
    const msg = await send(alice, source.id, 'private');

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${source.id}/forward`,
      headers: { cookie: mallory.cookie },
      payload: { toChatId: mine.id, seqs: [msg.seq] },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a forwarded copy gets its own expiry, not the original’s', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const source = await openChat(alice, bob.id);
    const destination = await openChat(alice, carol.id);
    const msg = await send(alice, source.id, 'ttl check');

    await app.inject({
      method: 'POST', url: `/api/chats/${source.id}/forward`,
      headers: { cookie: alice.cookie },
      payload: { toChatId: destination.id, seqs: [msg.seq] },
    });

    const { rows } = await harness.store.pool.query(
      `SELECT expires_at FROM messages WHERE chat_id = $1`, [destination.id]
    );
    const lifetime = new Date(rows[0].expires_at) - Date.now();
    assert.ok(lifetime > 0 && lifetime <= 24 * 3600 * 1000 + 5000, 'still within the ceiling');
  });
});

describe('drafts', () => {
  test('saves and lists a draft', async () => {
    const { alice, chat } = await pair();

    const res = await app.inject({
      method: 'PUT', url: `/api/chats/${chat.id}/draft`,
      headers: { cookie: alice.cookie }, payload: { body: 'half-written thought' },
    });
    assert.equal(res.statusCode, 200);

    const drafts = (await app.inject({
      method: 'GET', url: '/api/drafts', headers: { cookie: alice.cookie },
    })).json().drafts;

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].body, 'half-written thought');
  });

  test('an empty body clears the draft', async () => {
    const { alice, chat } = await pair();
    await app.inject({
      method: 'PUT', url: `/api/chats/${chat.id}/draft`,
      headers: { cookie: alice.cookie }, payload: { body: 'something' },
    });
    await app.inject({
      method: 'PUT', url: `/api/chats/${chat.id}/draft`,
      headers: { cookie: alice.cookie }, payload: { body: '   ' },
    });

    const drafts = (await app.inject({
      method: 'GET', url: '/api/drafts', headers: { cookie: alice.cookie },
    })).json().drafts;
    assert.equal(drafts.length, 0);
  });

  test('drafts are private to their author', async () => {
    const { alice, bob, chat } = await pair();
    await app.inject({
      method: 'PUT', url: `/api/chats/${chat.id}/draft`,
      headers: { cookie: alice.cookie }, payload: { body: 'alice only' },
    });

    const bobDrafts = (await app.inject({
      method: 'GET', url: '/api/drafts', headers: { cookie: bob.cookie },
    })).json().drafts;
    assert.equal(bobDrafts.length, 0);
  });

  test('a secret chat refuses server-side drafts', async () => {
    // A draft is plaintext; syncing one would hand the server exactly what
    // the conversation exists to withhold.
    const { alice, chat } = await pair('secret');
    const res = await app.inject({
      method: 'PUT', url: `/api/chats/${chat.id}/draft`,
      headers: { cookie: alice.cookie }, payload: { body: 'should stay local' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /kept on the device/i);
  });
});

describe('chat settings', () => {
  test('mutes and unmutes', async () => {
    const { alice, chat } = await pair();
    const until = new Date(Date.now() + 3600_000).toISOString();

    const muted = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { mutedUntil: until },
    });
    assert.ok(muted.json().mutedUntil);

    const unmuted = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { mutedUntil: null },
    });
    assert.equal(unmuted.json().mutedUntil, null);
  });

  test('archives, and archived chats leave the default list', async () => {
    const { alice, chat } = await pair();

    await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { archived: true },
    });

    const visible = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: alice.cookie },
    })).json().chats;
    assert.equal(visible.length, 0);

    const all = (await app.inject({
      method: 'GET', url: '/api/chats?archived=true', headers: { cookie: alice.cookie },
    })).json().chats;
    assert.equal(all.length, 1);
  });

  test('settings are per user, not per chat', async () => {
    const { alice, bob, chat } = await pair();
    await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { archived: true },
    });

    const bobsView = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: bob.cookie },
    })).json().chats;
    assert.equal(bobsView.length, 1, 'bob still sees the chat');
  });

  test('a per-chat ttl above the ceiling is rejected', async () => {
    const { alice, chat } = await pair();
    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { ttlSecs: 172800 },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('blocking', () => {
  test('blocks and lists', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await app.inject({
      method: 'POST', url: `/api/users/${bob.id}/block`, headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 201);

    const blocked = (await app.inject({
      method: 'GET', url: '/api/blocks', headers: { cookie: alice.cookie },
    })).json().blocked;
    assert.equal(blocked[0].id, bob.id);
  });

  test('blocking is symmetric in effect', async () => {
    // Whoever pressed the button, neither should reach the other.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    assert.equal(await harness.store.phase2.isBlockedBetween(alice.id, bob.id), true);
    assert.equal(await harness.store.phase2.isBlockedBetween(bob.id, alice.id), true);
  });

  test('unblocks', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    await app.inject({
      method: 'DELETE', url: `/api/users/${bob.id}/block`, headers: { cookie: alice.cookie },
    });
    assert.equal(await harness.store.phase2.isBlockedBetween(alice.id, bob.id), false);
  });

  test('a blocked user cannot send in a secret chat', async () => {
    // The check that matters: recording a block without enforcing it is
    // worse than no blocking, because the user believes they are protected.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: bob.cookie },
      payload: { recipientId: alice.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });

    assert.equal(res.statusCode, 403);
    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE sender_id = $1`, [bob.id]
    );
    assert.equal(rows[0].n, 0, 'nothing was stored');
  });

  test('the block works in both directions', async () => {
    // Whoever pressed the button, neither party can reach the other.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    const fromBlocker = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: { recipientId: bob.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });
    assert.equal(fromBlocker.statusCode, 403);
  });

  test('the rejection does not reveal that a block exists', async () => {
    // Telling a sender "you have been blocked" hands them information the
    // person who blocked them did not choose to share.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: bob.cookie },
      payload: { recipientId: alice.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });

    assert.doesNotMatch(res.json().error, /block/i);
  });

  test('a blocked user cannot send in a cloud chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await harness.store.phase2.block(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: bob.cookie }, payload: { body: 'should not arrive' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a blocked user cannot open a new chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: bob.cookie }, payload: { peerId: alice.id },
    });
    assert.equal(res.statusCode, 403);
  });

  test('unblocking restores delivery', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.block(alice.id, bob.id);
    await harness.store.phase2.unblock(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: bob.cookie },
      payload: { recipientId: alice.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0 },
    });
    assert.equal(res.statusCode, 201);
  });

  test('blocking does not silence a shared group', async () => {
    // Blocking someone should not remove your ability to speak in a room you
    // both happen to be in — that would let one person mute another globally.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    const group = (await app.inject({
      method: 'POST', url: '/api/groups',
      headers: { cookie: carol.cookie },
      payload: { name: 'shared room', members: [alice.id, bob.id] },
    })).json();

    await harness.store.phase2.block(alice.id, bob.id);

    const res = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: bob.cookie },
      payload: {
        recipientId: carol.id, groupId: group.id,
        ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0,
      },
    });
    assert.equal(res.statusCode, 201, 'bob can still address carol in the group');
  });

  test('you cannot block yourself', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'POST', url: `/api/users/${alice.id}/block`, headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('global search', () => {
  test('finds a message in the caller’s own chat', async () => {
    const { alice, chat } = await pair();
    await send(alice, chat.id, 'the quick brown fox');

    const res = await app.inject({
      method: 'GET', url: '/api/search/messages?q=brown', headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().results.length, 1);
    assert.match(res.json().results[0].body, /brown/);
  });

  test('never returns messages from a chat the caller is not in', async () => {
    // An unscoped version of this query is a full-database content leak.
    const { alice, chat } = await pair();
    await send(alice, chat.id, 'confidential pineapple');

    const mallory = await registerUser(app);
    const res = await app.inject({
      method: 'GET', url: '/api/search/messages?q=pineapple', headers: { cookie: mallory.cookie },
    });

    assert.equal(res.json().results.length, 0);
  });

  test('secret chats are excluded structurally', async () => {
    // They have no plaintext body, so there is nothing to index — the
    // exclusion is not a filter someone could forget to apply.
    const { alice, chat } = await pair('secret');
    await harness.store.pool.query(
      `INSERT INTO messages (chat_id, seq, sender_id, ciphertext, expires_at, sent_at)
       VALUES ($1, 1, $2, 'encrypted-blob', now() + interval '1 hour', now())`,
      [chat.id, alice.id]
    );

    const res = await app.inject({
      method: 'GET', url: '/api/search/messages?q=encrypted', headers: { cookie: alice.cookie },
    });
    assert.equal(res.json().results.length, 0);
    assert.equal(res.json().excludesSecretChats, true);
  });

  test('states the retention window so the UI need not infer it', async () => {
    const { alice } = await pair();
    const res = await app.inject({
      method: 'GET', url: '/api/search/messages?q=anything', headers: { cookie: alice.cookie },
    });
    assert.equal(res.json().retentionSeconds, 86400);
  });

  test('does not return messages deleted for the caller', async () => {
    const { alice, bob, chat } = await pair();
    const msg = await send(alice, chat.id, 'forgettable elephant');

    await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}`,
      headers: { cookie: bob.cookie },
    });

    const bobResults = (await app.inject({
      method: 'GET', url: '/api/search/messages?q=elephant', headers: { cookie: bob.cookie },
    })).json().results;
    const aliceResults = (await app.inject({
      method: 'GET', url: '/api/search/messages?q=elephant', headers: { cookie: alice.cookie },
    })).json().results;

    assert.equal(bobResults.length, 0, 'hidden for bob');
    assert.equal(aliceResults.length, 1, 'still there for alice');
  });

  test('does not return tombstoned messages', async () => {
    const { alice, chat } = await pair();
    const msg = await send(alice, chat.id, 'retracted statement');

    await app.inject({
      method: 'DELETE', url: `/api/chats/${chat.id}/messages/${msg.seq}?forEveryone=true`,
      headers: { cookie: alice.cookie },
    });

    const res = await app.inject({
      method: 'GET', url: '/api/search/messages?q=retracted', headers: { cookie: alice.cookie },
    });
    assert.equal(res.json().results.length, 0);
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search/messages?q=x' });
    assert.equal(res.statusCode, 401);
  });
});

describe('presence', () => {
  test('reports offline with a last-seen for a user with no socket', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.touchLastSeen(bob.id);

    const res = await app.inject({
      method: 'GET', url: `/api/presence?userIds=${bob.id}`, headers: { cookie: alice.cookie },
    });

    assert.equal(res.statusCode, 200);
    const [presence] = res.json().presence;
    assert.equal(presence.online, false);
    assert.ok(presence.lastSeenAt);
  });

  test('honours a user who hides their presence', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await harness.store.phase2.touchLastSeen(bob.id);
    await harness.store.pool.query(
      `UPDATE users SET presence_privacy = 'nobody' WHERE id = $1`, [bob.id]
    );

    const res = await app.inject({
      method: 'GET', url: `/api/presence?userIds=${bob.id}`, headers: { cookie: alice.cookie },
    });

    const [presence] = res.json().presence;
    assert.equal(presence.lastSeenAt, null);
    assert.equal(presence.online, false, 'hidden even while connected');
  });

  test('ignores malformed ids rather than erroring', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'GET', url: '/api/presence?userIds=not-a-uuid,also-bad',
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().presence, []);
  });
});
