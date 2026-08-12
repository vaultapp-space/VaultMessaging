import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Thoughts: public posts. The invariants worth guarding are the ones that make
// this surface different from every other one in the app — it is not gated by
// chat membership, so visibility is decided entirely by blocks and mutes, and
// it is paginated by keyset rather than by a per-chat seq.

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
  return app.inject({
    method: 'POST',
    url: '/api/posts',
    headers: { cookie: user.cookie },
    payload,
  });
}

async function timeline(user, query = '') {
  const res = await app.inject({
    method: 'GET',
    url: `/api/posts/timeline${query}`,
    headers: { cookie: user.cookie },
  });
  return { res, body: res.statusCode === 200 ? JSON.parse(res.body) : null };
}

describe('creating a post', () => {
  test('a post is created and comes back on the global timeline', async () => {
    const alice = await registerUser(app);

    const created = await post(alice, { body: 'hello world' });
    assert.equal(created.statusCode, 201, created.body);

    const { body } = await timeline(alice);
    assert.equal(body.posts.length, 1);
    assert.equal(body.posts[0].body, 'hello world');
    assert.equal(body.posts[0].username, alice.username);
  });

  test('a post is visible to a stranger — this surface is not membership-gated', async () => {
    // The property that makes Thoughts different from every other content type
    // here. If this ever fails, the feed has quietly become a private channel.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await post(alice, { body: 'to nobody in particular' });

    const { body } = await timeline(bob);
    assert.equal(body.posts.length, 1);
    assert.equal(body.posts[0].body, 'to nobody in particular');
  });

  test('an empty post is refused', async () => {
    const alice = await registerUser(app);
    const res = await post(alice, { body: '   ' });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('a post over 500 characters is refused by the schema', async () => {
    const alice = await registerUser(app);
    const res = await post(alice, { body: 'x'.repeat(501) });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('a post cannot be both a reply and a repost', async () => {
    const alice = await registerUser(app);
    const root = JSON.parse((await post(alice, { body: 'root' })).body).post;

    const res = await post(alice, { body: 'both', replyToId: root.id, repostOfId: root.id });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('posts expire within the 24h ceiling', async () => {
    // The whole design leans on this: the table never holds more than a day,
    // which is what keeps a chronological global timeline cheap.
    const alice = await registerUser(app);
    const created = JSON.parse((await post(alice, { body: 'ephemeral' })).body).post;

    const ttlMs = new Date(created.expiresAt) - new Date(created.createdAt);
    assert.ok(ttlMs <= 86400 * 1000, `ttl was ${ttlMs}ms`);
    assert.ok(ttlMs > 86000 * 1000, `ttl was ${ttlMs}ms`);
  });
});

describe('replies and reposts', () => {
  test('a reply never outlives the post it answers', async () => {
    // Not tidiness. A child that outlives its parent dies by ON DELETE CASCADE,
    // and cascade-deleted rows are never returned by DELETE ... RETURNING — so
    // the reaper would never see the child's media and would leave the file on
    // disk forever, publicly readable.
    const alice = await registerUser(app);
    const root = JSON.parse((await post(alice, { body: 'root' })).body).post;

    // Age the parent so a fresh 24h child would overshoot it.
    await harness.store.pool.query(
      `UPDATE posts SET expires_at = now() + interval '1 hour' WHERE id = $1`,
      [root.id]
    );

    const reply = JSON.parse((await post(alice, { body: 'reply', replyToId: root.id })).body).post;
    const parentExpiry = (await harness.store.pool.query(
      'SELECT expires_at FROM posts WHERE id = $1', [root.id]
    )).rows[0].expires_at;

    assert.ok(
      new Date(reply.expiresAt) <= new Date(parentExpiry),
      'reply outlived the post it answers'
    );
  });

  test('a reply bumps the parent reply count and stays off the timeline', async () => {
    const alice = await registerUser(app);
    const root = JSON.parse((await post(alice, { body: 'root' })).body).post;
    await post(alice, { body: 'a reply', replyToId: root.id });

    const { body } = await timeline(alice);
    // The timeline is top-level posts only; a reply appearing here would make
    // every conversation flood the feed.
    assert.equal(body.posts.length, 1);
    assert.equal(body.posts[0].repliesCount, 1);
  });

  test('replying to a missing post is a 404, not a 400', async () => {
    const alice = await registerUser(app);
    const res = await post(alice, {
      body: 'into the void',
      replyToId: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(res.statusCode, 404, res.body);
  });

  test('a repost appears on the timeline in its own right', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const original = JSON.parse((await post(alice, { body: 'original' })).body).post;

    const res = await post(bob, { repostOfId: original.id });
    assert.equal(res.statusCode, 201, res.body);

    const { body } = await timeline(bob);
    assert.equal(body.posts.length, 2);
    assert.ok(body.posts.some((p) => p.repostOfId === original.id));
  });
});

describe('visibility', () => {
  test('blocking hides posts in both directions', async () => {
    // Symmetric, matching phase8.repo.feedFor. A one-way block would let the
    // blocked party keep watching, which is not what a user means by blocking.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await post(alice, { body: 'from alice' });
    await post(bob, { body: 'from bob' });

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/users/${alice.id}/block`,
      headers: { cookie: bob.cookie },
      payload: {},
    });
    assert.equal(blocked.statusCode, 201, blocked.body);

    const bobSees = (await timeline(bob)).body.posts.map((p) => p.body);
    assert.deepEqual(bobSees, ['from bob']);

    const aliceSees = (await timeline(alice)).body.posts.map((p) => p.body);
    assert.deepEqual(aliceSees, ['from alice']);
  });

  test('a blocked author is filtered without shortening the page', async () => {
    // The filter is a SQL predicate, not a post-fetch array filter. If it were
    // the latter, a page containing a blocked author would come back short and
    // pagination would stutter.
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    // Interleaved on purpose. Posting all of alice's first would put bob's
    // three newest at the top, and the assertion below would pass even with no
    // filtering at all — the test would be green and prove nothing.
    for (let i = 0; i < 3; i += 1) {
      await post(alice, { body: `alice ${i}` });
      await post(bob, { body: `bob ${i}` });
    }

    await app.inject({
      method: 'POST',
      url: `/api/users/${alice.id}/block`,
      headers: { cookie: bob.cookie },
      payload: {},
    });

    const { body } = await timeline(bob, '?limit=3');
    assert.equal(body.posts.length, 3, 'page came back short');
    assert.ok(body.posts.every((p) => p.username === bob.username));
  });

  test('fetching a blocked author\'s post by id is a 404', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = JSON.parse((await post(alice, { body: 'hidden' })).body).post;

    await app.inject({
      method: 'POST',
      url: `/api/users/${alice.id}/block`,
      headers: { cookie: bob.cookie },
      payload: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/posts/${p.id}`,
      headers: { cookie: bob.cookie },
    });
    // Indistinguishable from deleted, on purpose.
    assert.equal(res.statusCode, 404);
  });
});

describe('pagination', () => {
  test('walks every post exactly once with no duplicates or gaps', async () => {
    const alice = await registerUser(app);
    const total = 7;
    for (let i = 0; i < total; i += 1) await post(alice, { body: `post ${i}` });

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const q = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await timeline(alice, q);
      seen.push(...body.posts.map((p) => p.id));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'a post was returned on two pages');
  });

  test('an unreadable cursor starts from the top rather than erroring', async () => {
    const alice = await registerUser(app);
    await post(alice, { body: 'only' });

    const { res, body } = await timeline(alice, '?cursor=not-a-real-cursor');
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(body.posts.length, 1);
  });
});

describe('deleting', () => {
  test('an author can delete their own post', async () => {
    const alice = await registerUser(app);
    const p = JSON.parse((await post(alice, { body: 'regrettable' })).body).post;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/posts/${p.id}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 204, res.body);

    const { body } = await timeline(alice);
    assert.equal(body.posts.length, 0);
  });

  test('deleting someone else\'s post is a 404', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = JSON.parse((await post(alice, { body: 'mine' })).body).post;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/posts/${p.id}`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 404);

    // And it really is still there.
    assert.equal((await timeline(alice)).body.posts.length, 1);
  });
});

describe('the reaper', () => {
  test('collects expired posts and their replies in one pass', async () => {
    const alice = await registerUser(app);
    const root = JSON.parse((await post(alice, { body: 'root' })).body).post;
    await post(alice, { body: 'reply', replyToId: root.id });

    await harness.store.pool.query(`UPDATE posts SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM posts');
    assert.equal(rows[0].n, 0);
  });

  test('leaves live posts alone', async () => {
    const alice = await registerUser(app);
    await post(alice, { body: 'still fresh' });

    await harness.store.reap();

    assert.equal((await timeline(alice)).body.posts.length, 1);
  });
});
