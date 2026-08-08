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

// Groups are created in secret mode; view-once is a cloud feature, so the
// mode is flipped directly, the same way the rest of the Phase 3 suite does.
async function makeCloudGroup(owner, members, name = 'the group') {
  const res = await app.inject({
    method: 'POST', url: '/api/groups',
    headers: { cookie: owner.cookie },
    payload: { name, members: members.map((m) => m.id) },
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

function view(user, chatId, seq) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/messages/${seq}/view`,
    headers: { cookie: user.cookie },
  });
}

function history(user, chatId) {
  return app.inject({
    method: 'GET', url: `/api/chats/${chatId}/messages`,
    headers: { cookie: user.cookie },
  });
}

// ============================================================
// View-once media
// ============================================================
// The property worth proving is that the *server* stops serving the content,
// not merely that a client agrees to hide it. A client-side-only "view once"
// is defeated by opening the network tab.

describe('view-once media', () => {
  test('opening a view-once message clears it for everyone', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const sent = (await send(alice, chat.id, {
      body: 'for your eyes only', viewOnce: true,
    })).json();

    // Bob can still fetch it before opening.
    const before = (await history(bob, chat.id)).json();
    assert.equal(before.messages[0].body, 'for your eyes only');

    const opened = (await view(bob, chat.id, sent.seq)).json();
    assert.equal(opened.consumed, true);

    // And now the server itself has nothing to hand back.
    const after = (await history(bob, chat.id)).json();
    assert.equal(after.messages[0].body, null);
    assert.equal(after.messages[0].media, null);

    // Including to the sender — a view-once message is gone, not archived.
    const senderView = (await history(alice, chat.id)).json();
    assert.equal(senderView.messages[0].body, null);
  });

  test('the message survives as a tombstone rather than vanishing', async () => {
    // A hole in the transcript is worse than a marker: the recipient should
    // be able to tell that something was sent and opened.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const sent = (await send(alice, chat.id, { body: 'poof', viewOnce: true })).json();
    await view(bob, chat.id, sent.seq);

    const after = (await history(bob, chat.id)).json();
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].viewOnce, true);
  });

  test('the author viewing their own message does not consume it', async () => {
    // Otherwise scrolling past your own send would destroy it before the
    // recipient ever opened the chat.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const sent = (await send(alice, chat.id, { body: 'still here', viewOnce: true })).json();

    const own = (await view(alice, chat.id, sent.seq)).json();
    assert.equal(own.consumed, false);

    const forBob = (await history(bob, chat.id)).json();
    assert.equal(forBob.messages[0].body, 'still here');
  });

  test('in a group it survives until every other member has opened it', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const group = await makeCloudGroup(alice, [bob, carol]);

    const sent = (await send(alice, group.id, { body: 'group secret', viewOnce: true })).json();

    const first = (await view(bob, group.id, sent.seq)).json();
    assert.equal(first.consumed, false, 'carol has not seen it yet');

    const stillThere = (await history(carol, group.id)).json();
    assert.equal(stillThere.messages[0].body, 'group secret');

    const second = (await view(carol, group.id, sent.seq)).json();
    assert.equal(second.consumed, true);

    const gone = (await history(carol, group.id)).json();
    assert.equal(gone.messages[0].body, null);
  });

  test('two simultaneous last viewers only consume the message once', async () => {
    // Regression test: recordView() used to read the "remaining viewers"
    // count and write the consuming view as two separate unguarded
    // statements. When the last two viewers opened it at the same instant,
    // each could run that count query before the other's view was visible,
    // so both saw themselves as last and both reported consumed:true —
    // firing message_consumed twice for one message.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const group = await makeCloudGroup(alice, [bob, carol]);

    const sent = (await send(alice, group.id, { body: 'race me', viewOnce: true })).json();

    const [bobRes, carolRes] = await Promise.all([
      view(bob, group.id, sent.seq),
      view(carol, group.id, sent.seq),
    ]);
    const consumedCount = [bobRes.json().consumed, carolRes.json().consumed]
      .filter(Boolean).length;
    assert.equal(consumedCount, 1, 'exactly one of the two simultaneous viewers should consume it');

    const gone = (await history(carol, group.id)).json();
    assert.equal(gone.messages[0].body, null);
  });

  test('an ordinary message is unaffected by being viewed', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const sent = (await send(alice, chat.id, { body: 'normal message' })).json();
    const opened = (await view(bob, chat.id, sent.seq)).json();
    assert.equal(opened.consumed, false);

    const after = (await history(bob, chat.id)).json();
    assert.equal(after.messages[0].body, 'normal message');
  });

  test('a non-member cannot view, or probe for, a message', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const outsider = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const sent = (await send(alice, chat.id, { body: 'private', viewOnce: true })).json();

    const res = await view(outsider, chat.id, sent.seq);
    assert.equal(res.statusCode, 404);

    // And the attempt must not have consumed it.
    const after = (await history(bob, chat.id)).json();
    assert.equal(after.messages[0].body, 'private');
  });
});

// ============================================================
// Albums
// ============================================================
// `grouped_id` already existed; what matters is that it round-trips, since
// the client groups consecutive messages by it.

describe('albums', () => {
  test('grouped messages keep their grouping through history', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await send(alice, chat.id, { body: 'one', groupedId: '5150' });
    await send(alice, chat.id, { body: 'two', groupedId: '5150' });
    await send(alice, chat.id, { body: 'unrelated' });

    const { messages } = (await history(bob, chat.id)).json();
    assert.equal(messages.length, 3);
    assert.equal(String(messages[0].groupedId), '5150');
    assert.equal(String(messages[1].groupedId), '5150');
    assert.equal(messages[2].groupedId, null);
  });
});

// ============================================================
// Chat themes
// ============================================================

describe('chat themes', () => {
  test('a theme is per-user, not pushed onto the other participant', async () => {
    // Picking a background for a conversation must not restyle it for the
    // person you are talking to.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { theme: 'forest' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().theme, 'forest');

    const mine = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: alice.cookie },
    })).json();
    assert.equal(mine.chats.find((c) => c.id === chat.id).theme, 'forest');

    const theirs = (await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: bob.cookie },
    })).json();
    assert.equal(theirs.chats.find((c) => c.id === chat.id).theme, null);
  });

  test('a theme can be cleared back to the default', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { theme: 'forest' },
    });

    const cleared = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { theme: null },
    });
    assert.equal(cleared.json().theme, null);
  });

  test('setting an unrelated preference leaves the theme alone', async () => {
    // The upsert treats null as "leave this column", and a mute must not
    // silently reset the theme.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = await openChat(alice, bob.id);

    await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { theme: 'forest' },
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${chat.id}/settings`,
      headers: { cookie: alice.cookie }, payload: { archived: true },
    });
    assert.equal(res.json().theme, 'forest');
  });
});
