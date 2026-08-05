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

let nameSeq = 0;
function uniqueUsername() {
  return `chan${(nameSeq += 1)}${Date.now().toString(36)}`.slice(0, 32);
}

async function makeChannel(owner, overrides = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/channels',
    headers: { cookie: owner.cookie },
    payload: { title: 'The Channel', username: uniqueUsername(), ...overrides },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function post(user, chatId, payload) {
  return app.inject({
    method: 'POST', url: `/api/channels/${chatId}/posts`,
    headers: { cookie: user.cookie }, payload,
  });
}

function readPosts(user, chatId) {
  return app.inject({
    method: 'GET', url: `/api/channels/${chatId}/posts`,
    headers: { cookie: user.cookie },
  });
}

function subscribe(user, chatId) {
  return app.inject({
    method: 'POST', url: `/api/channels/${chatId}/subscribe`,
    headers: { cookie: user.cookie },
  });
}

// ============================================================
// Creation and discovery
// ============================================================

describe('channels', () => {
  test('a channel is created in cloud mode, never secret', async () => {
    // Not an oversight. Sender keys assume a membership small enough to rekey
    // when someone leaves; a channel anyone can join and leave would be
    // rekeying constantly while still handing the key to every subscriber.
    // Claiming E2EE here would be a lie with a padlock on it.
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);

    assert.equal(channel.type, 'channel');
    assert.equal(channel.mode, 'cloud');
    assert.equal(channel.isBroadcast, true);
  });

  test('the creator is an admin, not a subscriber', async () => {
    // The two live in different tables on purpose: admins are a handful of
    // rows carrying the full rights model, subscribers are a partitioned
    // table that can run to seven figures.
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);

    const view = (await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}`,
      headers: { cookie: owner.cookie },
    })).json();

    assert.equal(view.canPost, true);
    assert.equal(view.subscribed, false);
  });

  test('a duplicate username is refused', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const name = uniqueUsername();

    await makeChannel(owner, { username: name });
    const res = await app.inject({
      method: 'POST', url: '/api/channels',
      headers: { cookie: other.cookie },
      payload: { title: 'Impostor', username: name },
    });
    assert.equal(res.statusCode, 409);
  });

  test('a public channel is findable by username', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const name = uniqueUsername();
    await makeChannel(owner, { username: name });

    const res = await app.inject({
      method: 'GET', url: `/api/channels/by-username/${name}`,
      headers: { cookie: reader.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().username, name);
  });

  test('a private channel cannot be joined by knowing its id', async () => {
    // Otherwise the id is a bearer credential, which is exactly the mistake
    // the old group join_key made.
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const channel = await makeChannel(owner, { username: null });

    const res = await subscribe(stranger, channel.id);
    assert.equal(res.statusCode, 403);
  });
});

// ============================================================
// Posting
// ============================================================

describe('channel posts', () => {
  test('an admin can post and subscribers can read', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    const sent = await post(owner, channel.id, { body: 'hello subscribers' });
    assert.equal(sent.statusCode, 201, sent.body);

    const { posts } = (await readPosts(reader, channel.id)).json();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body, 'hello subscribers');
  });

  test('a subscriber cannot post', async () => {
    // A channel is broadcast: the difference between a channel and a group
    // is precisely that subscribers do not get to write.
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    // 404, not 403: a subscriber is not a *member*. Admins and subscribers
    // are deliberately different tables, so from the rights model's point of
    // view a subscriber is a stranger — and telling a stranger a private
    // channel exists is itself a leak.
    const res = await post(reader, channel.id, { body: 'let me in' });
    assert.equal(res.statusCode, 404);
  });

  test('a stranger cannot post, and is not told the channel exists', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const channel = await makeChannel(owner);

    const res = await post(stranger, channel.id, { body: 'hello' });
    assert.equal(res.statusCode, 404);
  });

  test('a private channel is not readable by a stranger', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const channel = await makeChannel(owner, { username: null });
    await post(owner, channel.id, { body: 'private' });

    const res = await readPosts(stranger, channel.id);
    assert.equal(res.statusCode, 404);
  });

  test('posting writes exactly one message row, whatever the subscriber count', async () => {
    // The scaling property the whole design rests on. If this ever becomes
    // O(subscribers), one post to a large channel becomes hundreds of
    // thousands of writes.
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);

    const readers = [];
    for (let i = 0; i < 5; i++) {
      const reader = await registerUser(app);
      await subscribe(reader, channel.id);
      readers.push(reader);
    }

    const before = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates`
    );
    await post(owner, channel.id, { body: 'one post' });

    const messages = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE chat_id = $1`, [channel.id]
    );
    assert.equal(messages.rows[0].n, 1);

    // And crucially, no per-subscriber update rows.
    const after = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM user_updates`
    );
    assert.equal(after.rows[0].n, before.rows[0].n,
      'a channel post must not append an update row per subscriber');
  });

  test('a post expires like every other message', async () => {
    // The 24h rule is most surprising here — a channel is exactly what people
    // expect to be an archive — so it gets its own standing assertion.
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);
    await post(owner, channel.id, { body: 'ephemeral' });

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE chat_id = $1 AND (expires_at IS NULL
              OR expires_at > now() + interval '24 hours')`,
      [channel.id]
    );
    assert.equal(rows[0].n, 0);
  });

  test('a channel survives its posts expiring', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);
    await post(owner, channel.id, { body: 'gone tomorrow' });

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 hour' WHERE chat_id = $1`,
      [channel.id]
    );
    await harness.store.reap();

    const res = await readPosts(reader, channel.id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().posts.length, 0, 'empty, but still there');
  });
});

// ============================================================
// Signed posts
// ============================================================

describe('signed posts', () => {
  test('posts are attributed to the channel by default', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    await post(owner, channel.id, { body: 'unsigned' });
    const { posts } = (await readPosts(reader, channel.id)).json();
    assert.equal(posts[0].postAuthor, null);
  });

  test('turning signatures on names the admin who posted', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    await app.inject({
      method: 'PATCH', url: `/api/channels/${channel.id}/settings`,
      headers: { cookie: owner.cookie }, payload: { signaturesEnabled: true },
    });
    await post(owner, channel.id, { body: 'signed' });

    const { posts } = (await readPosts(reader, channel.id)).json();
    assert.equal(posts[0].postAuthor, owner.username);
  });

  test('a subscriber cannot change channel settings', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    const res = await app.inject({
      method: 'PATCH', url: `/api/channels/${channel.id}/settings`,
      headers: { cookie: reader.cookie }, payload: { signaturesEnabled: true },
    });
    assert.equal(res.statusCode, 404, 'a subscriber is not a member');
  });
});

// ============================================================
// Views
// ============================================================

describe('view counts', () => {
  test('a view is counted, and counted once per reader', async () => {
    // Deduplicated so refreshing does not inflate the number, and held in
    // Redis so a hot post does not turn one row into a lock queue.
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);
    const sent = (await post(owner, channel.id, { body: 'popular' })).json();

    const first = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/view`,
      headers: { cookie: reader.cookie },
    });
    assert.equal(first.json().views, 1);

    const again = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/view`,
      headers: { cookie: reader.cookie },
    });
    assert.equal(again.json().views, 1, 'the same reader does not count twice');
  });

  test('two readers count as two views', async () => {
    const owner = await registerUser(app);
    const a = await registerUser(app);
    const b = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(a, channel.id);
    await subscribe(b, channel.id);
    const sent = (await post(owner, channel.id, { body: 'popular' })).json();

    await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/view`,
      headers: { cookie: a.cookie },
    });
    const second = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/view`,
      headers: { cookie: b.cookie },
    });
    assert.equal(second.json().views, 2);
  });

  test('a stranger cannot inflate a private channel\'s views', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const channel = await makeChannel(owner, { username: null });
    const sent = (await post(owner, channel.id, { body: 'private' })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/view`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================
// Comments
// ============================================================

describe('channel comments', () => {
  async function withDiscussion(owner) {
    const channel = await makeChannel(owner);
    // A group needs at least one other member to be created at all.
    const filler = await registerUser(app);
    const group = (await app.inject({
      method: 'POST', url: '/api/groups',
      headers: { cookie: owner.cookie },
      payload: { name: 'Discussion', members: [filler.id] },
    })).json();
    await harness.store.pool.query(
      `UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]
    );
    await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/discussion`,
      headers: { cookie: owner.cookie }, payload: { groupId: group.id },
    });
    return { channel, group };
  }

  test('a comment lands in the linked group and bumps the count', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const { channel } = await withDiscussion(owner);
    await subscribe(reader, channel.id);

    const sent = (await post(owner, channel.id, { body: 'discuss this' })).json();

    const commented = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/comments`,
      headers: { cookie: reader.cookie }, payload: { body: 'good post' },
    });
    assert.equal(commented.statusCode, 201, commented.body);
    assert.equal(commented.json().repliesCount, 1);

    const { posts } = (await readPosts(reader, channel.id)).json();
    assert.equal(posts[0].repliesCount, 1);
  });

  test('comments are readable and carry their author', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const { channel } = await withDiscussion(owner);
    await subscribe(reader, channel.id);
    const sent = (await post(owner, channel.id, { body: 'discuss' })).json();

    await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/comments`,
      headers: { cookie: reader.cookie }, payload: { body: 'first' },
    });

    const { comments } = (await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}/posts/${sent.seq}/comments`,
      headers: { cookie: reader.cookie },
    })).json();
    assert.equal(comments.length, 1);
    assert.equal(comments[0].body, 'first');
    assert.equal(comments[0].senderUsername, reader.username);
  });

  test('a channel with no discussion group refuses comments', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);
    const sent = (await post(owner, channel.id, { body: 'no comments' })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts/${sent.seq}/comments`,
      headers: { cookie: reader.cookie }, payload: { body: 'hello?' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a group you do not administer cannot be attached as a discussion', async () => {
    // Otherwise anyone could bolt their channel's comment section onto
    // someone else's private conversation.
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const channel = await makeChannel(owner);

    const filler = await registerUser(app);
    const theirGroup = (await app.inject({
      method: 'POST', url: '/api/groups',
      headers: { cookie: other.cookie },
      payload: { name: 'Not yours', members: [filler.id] },
    })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/discussion`,
      headers: { cookie: owner.cookie }, payload: { groupId: theirGroup.id },
    });
    assert.equal(res.statusCode, 403);
  });
});

// ============================================================
// Admin log
// ============================================================

describe('admin log', () => {
  test('creating a channel and changing settings are recorded', async () => {
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);
    await app.inject({
      method: 'PATCH', url: `/api/channels/${channel.id}/settings`,
      headers: { cookie: owner.cookie }, payload: { signaturesEnabled: true },
    });

    const { entries } = (await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}/admin-log`,
      headers: { cookie: owner.cookie },
    })).json();

    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('channel_created'));
    assert.ok(actions.includes('signatures_on'));
    assert.equal(entries[0].actor, owner.username);
  });

  test('a subscriber cannot read the admin log', async () => {
    // It records which admin took which action, which is not subscribers'
    // business.
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const channel = await makeChannel(owner);
    await subscribe(reader, channel.id);

    const res = await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}/admin-log`,
      headers: { cookie: reader.cookie },
    });
    assert.equal(res.statusCode, 404);
  });

  test('the admin log is deliberately exempt from the 24h rule', async () => {
    // An audit trail that erased itself daily would not be one. The trade is
    // that `details` must never carry message content — that would smuggle
    // it past the retention ceiling.
    const owner = await registerUser(app);
    const channel = await makeChannel(owner);
    await harness.store.reap();

    const { entries } = (await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}/admin-log`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.ok(entries.length > 0, 'the log survives a reaper pass');
  });
});
