import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Notifications for the public feed. The interesting cases are all about not
// notifying: yourself, repeatedly, or about something that has been undone.
// Getting those wrong turns a bell into either noise or a weapon.

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

async function post(user, payload) {
  const res = await app.inject({
    method: 'POST', url: '/api/posts', headers: { cookie: user.cookie }, payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).post;
}

async function notifications(user) {
  const res = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie: user.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

function act(user, method, url) {
  return app.inject({ method, url, headers: { cookie: user.cookie } });
}

async function idOf(user) {
  const { rows } = await harness.store.pool.query(
    'SELECT id FROM users WHERE username = $1', [user.username]
  );
  return rows[0].id;
}

describe('notifications', () => {
  test('a like notifies the author', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });

    await act(bob, 'POST', `/api/posts/${p.id}/like`);

    const { notifications: list, unreadCount } = await notifications(alice);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'like');
    assert.equal(list[0].actorUsername, bob.username);
    assert.equal(list[0].postId, p.id);
    assert.equal(list[0].read, false);
    assert.equal(unreadCount, 1);
  });

  test('a reply and a repost notify, and carry the post they are about', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'the original' });

    await post(bob, { body: 'answering', replyToId: p.id });
    await post(bob, { body: null, repostOfId: p.id });

    const { notifications: list } = await notifications(alice);
    assert.deepEqual(list.map((n) => n.kind).sort(), ['reply', 'repost']);
    assert.ok(list.every((n) => n.postId === p.id));
    assert.ok(list.every((n) => n.postExcerpt === 'the original'));
  });

  test('a follow notifies the person followed', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await act(bob, 'POST', `/api/users/${await idOf(alice)}/follow`);

    const { notifications: list } = await notifications(alice);
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'follow');
    assert.equal(list[0].postId, null);
  });

  test('your own actions never notify you', async () => {
    // Liking your own post is not news. Stored rows nobody will be shown are
    // a table growing for no reason.
    const alice = await registerUser(app);
    const p = await post(alice, { body: 'mine' });

    await act(alice, 'POST', `/api/posts/${p.id}/like`);
    await post(alice, { body: 'my own reply', replyToId: p.id });

    const { notifications: list, unreadCount } = await notifications(alice);
    assert.equal(list.length, 0);
    assert.equal(unreadCount, 0);
  });

  test('liking twice is one notification', async () => {
    // Without the unique index this is a free way to fill someone's list:
    // like, unlike, like, forever.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });

    await act(bob, 'POST', `/api/posts/${p.id}/like`);
    await act(bob, 'POST', `/api/posts/${p.id}/like`);

    const { notifications: list } = await notifications(alice);
    assert.equal(list.length, 1);
  });

  test('unliking withdraws the notification', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });

    await act(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal((await notifications(alice)).notifications.length, 1);

    await act(bob, 'DELETE', `/api/posts/${p.id}/like`);
    assert.equal((await notifications(alice)).notifications.length, 0,
      'the bell must not claim a like that no longer exists');

    // And a genuine re-like notifies again — withdrawing is what frees the
    // unique index to accept a new row.
    await act(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal((await notifications(alice)).notifications.length, 1);
  });

  test('unfollowing withdraws it too', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const aliceId = await idOf(alice);

    await act(bob, 'POST', `/api/users/${aliceId}/follow`);
    assert.equal((await notifications(alice)).notifications.length, 1);

    await act(bob, 'DELETE', `/api/users/${aliceId}/follow`);
    assert.equal((await notifications(alice)).notifications.length, 0);
  });

  test('a blocked actor disappears from the list and the count', async () => {
    // Blocking is symmetric everywhere else in the feed. A notification list
    // that still named them would be a hole in it.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });

    await act(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal((await notifications(alice)).unreadCount, 1);

    await app.inject({
      method: 'POST', url: `/api/users/${await idOf(bob)}/block`,
      headers: { cookie: alice.cookie }, payload: {},
    });

    const after = await notifications(alice);
    assert.equal(after.notifications.length, 0);
    assert.equal(after.unreadCount, 0, 'the badge and the list must agree');
  });

  test('marking read clears the count but keeps the list', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });
    await act(bob, 'POST', `/api/posts/${p.id}/like`);

    const res = await act(alice, 'POST', '/api/notifications/read');
    assert.equal(res.statusCode, 204);

    const after = await notifications(alice);
    assert.equal(after.unreadCount, 0);
    assert.equal(after.notifications.length, 1, 'read is not deleted');
    assert.equal(after.notifications[0].read, true);
  });

  test('a notification never outlives the post it is about', async () => {
    // Otherwise you tap "X liked your post" and land on nothing.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hello' });
    await act(bob, 'POST', `/api/posts/${p.id}/like`);

    await harness.store.pool.query(`UPDATE posts SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM notifications');
    assert.equal(rows[0].n, 0, 'cascaded with the post');
  });

  test('an expired follow notification is reaped even with no post to cascade from', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await act(bob, 'POST', `/api/users/${await idOf(alice)}/follow`);

    // Asserted before ageing them: without this the test passes on an empty
    // table, which is exactly how it behaved while follow notifications were
    // silently not being written at all.
    const seeded = await harness.store.pool.query('SELECT count(*)::int AS n FROM notifications');
    assert.equal(seeded.rows[0].n, 1, 'precondition: the follow was recorded');

    await harness.store.pool.query(`UPDATE notifications SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM notifications');
    assert.equal(rows[0].n, 0);
  });
});
