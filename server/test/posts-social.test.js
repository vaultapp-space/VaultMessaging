import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Thoughts phase 2: the social graph and engagement. The invariants here are
// mostly about two things agreeing with each other — the like row and the
// denormalised counter, the follow row and what the Following tab returns.

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

const send = (user, method, url, payload) => app.inject({
  method, url, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}),
});

async function timeline(user, query = '') {
  const res = await send(user, 'GET', `/api/posts/timeline${query}`);
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body);
}

describe('likes', () => {
  test('the counter and the membership row agree', async () => {
    // The bug users notice first is a filled heart next to a count that
    // disagrees with it, so both come back from the same statement.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'like me' });

    const liked = await send(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal(liked.statusCode, 200, liked.body);
    assert.equal(JSON.parse(liked.body).likesCount, 1);

    const { posts } = await timeline(bob);
    assert.equal(posts[0].likesCount, 1);
    assert.equal(posts[0].likedByMe, true);
  });

  test('likedByMe is per viewer, not global', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'shared' });
    await send(bob, 'POST', `/api/posts/${p.id}/like`);

    assert.equal((await timeline(alice)).posts[0].likedByMe, false);
    assert.equal((await timeline(alice)).posts[0].likesCount, 1);
  });

  test('liking twice does not double-count', async () => {
    // ON CONFLICT DO NOTHING makes the second insert return no rows, so the
    // counter moves by zero. A double-tap is the normal case, not an edge one.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'twice' });

    await send(bob, 'POST', `/api/posts/${p.id}/like`);
    const second = await send(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal(JSON.parse(second.body).likesCount, 1);
  });

  test('unliking is idempotent and never goes negative', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'fickle' });

    await send(bob, 'POST', `/api/posts/${p.id}/like`);
    await send(bob, 'DELETE', `/api/posts/${p.id}/like`);
    const again = await send(bob, 'DELETE', `/api/posts/${p.id}/like`);
    assert.equal(JSON.parse(again.body).likesCount, 0);
  });

  test('the stored counter matches the actual number of like rows', async () => {
    const alice = await registerUser(app);
    const p = await post(alice, { body: 'counted' });
    const likers = [];
    for (let i = 0; i < 4; i += 1) likers.push(await registerUser(app));
    for (const u of likers) await send(u, 'POST', `/api/posts/${p.id}/like`);
    await send(likers[0], 'DELETE', `/api/posts/${p.id}/like`);

    const { rows } = await harness.store.pool.query(
      `SELECT p.likes_count,
              (SELECT count(*)::int FROM post_likes l WHERE l.post_id = p.id) AS actual
         FROM posts p WHERE p.id = $1`,
      [p.id]
    );
    assert.equal(rows[0].likes_count, rows[0].actual);
  });

  test('liking a post you cannot see is a 404', async () => {
    // Otherwise the counter is an oracle for the existence of hidden posts.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'hidden' });
    await send(bob, 'POST', `/api/users/${alice.id}/block`, {});

    const res = await send(bob, 'POST', `/api/posts/${p.id}/like`);
    assert.equal(res.statusCode, 404);
  });
});

describe('following', () => {
  test('the Following tab shows followed authors and your own posts', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    await post(alice, { body: 'from alice' });
    await post(carol, { body: 'from carol' });
    await post(bob, { body: 'from bob' });

    await send(bob, 'POST', `/api/users/${alice.id}/follow`);

    const bodies = (await timeline(bob, '?tab=following')).posts.map((p) => p.body);
    assert.deepEqual(bodies.sort(), ['from alice', 'from bob'].sort());
  });

  test('the global tab is unaffected by who you follow', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await post(alice, { body: 'from alice' });

    assert.equal((await timeline(bob, '?tab=global')).posts.length, 1);
    assert.equal((await timeline(bob, '?tab=following')).posts.length, 0);
  });

  test('following is idempotent and self-follow is refused', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    assert.equal((await send(bob, 'POST', `/api/users/${alice.id}/follow`)).statusCode, 204);
    assert.equal((await send(bob, 'POST', `/api/users/${alice.id}/follow`)).statusCode, 204);
    assert.equal((await send(bob, 'POST', `/api/users/${bob.id}/follow`)).statusCode, 409);

    const res = await send(alice, 'GET', `/api/users/${alice.id}/followers`);
    assert.equal(JSON.parse(res.body).users.length, 1);
  });

  test('unfollowing empties the Following tab again', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await post(alice, { body: 'transient interest' });

    await send(bob, 'POST', `/api/users/${alice.id}/follow`);
    assert.equal((await timeline(bob, '?tab=following')).posts.length, 1);

    await send(bob, 'DELETE', `/api/users/${alice.id}/follow`);
    assert.equal((await timeline(bob, '?tab=following')).posts.length, 0);
  });

  test('following someone who does not exist is a 404', async () => {
    const bob = await registerUser(app);
    const res = await send(bob, 'POST', '/api/users/00000000-0000-4000-8000-000000000000/follow');
    assert.equal(res.statusCode, 404);
  });
});

describe('mutes', () => {
  test('muting hides an author one-way and silently', async () => {
    // Unlike a block, the muted party is unaffected — they still see the
    // muter's posts, and nothing tells them anything happened.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await post(alice, { body: 'noisy' });
    await post(bob, { body: 'quiet' });

    assert.equal((await send(bob, 'POST', `/api/users/${alice.id}/mute`)).statusCode, 204);

    assert.deepEqual((await timeline(bob)).posts.map((p) => p.body), ['quiet']);
    assert.equal((await timeline(alice)).posts.length, 2, 'mute leaked to the muted user');
  });

  test('unmuting restores the author', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await post(alice, { body: 'back again' });

    await send(bob, 'POST', `/api/users/${alice.id}/mute`);
    assert.equal((await timeline(bob)).posts.length, 0);

    await send(bob, 'DELETE', `/api/users/${alice.id}/mute`);
    assert.equal((await timeline(bob)).posts.length, 1);
  });

  test('the mute list is readable', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await send(bob, 'POST', `/api/users/${alice.id}/mute`);

    const res = await send(bob, 'GET', '/api/mutes');
    const { users } = JSON.parse(res.body);
    assert.equal(users.length, 1);
    assert.equal(users[0].username, alice.username);
  });
});

describe('threads', () => {
  test('replies come back oldest first under their root', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const root = await post(alice, { body: 'question' });
    await post(bob, { body: 'first answer', replyToId: root.id });
    await post(alice, { body: 'second answer', replyToId: root.id });

    const res = await send(bob, 'GET', `/api/posts/${root.id}/replies`);
    const { posts } = JSON.parse(res.body);
    assert.deepEqual(posts.map((p) => p.body), ['first answer', 'second answer']);
  });

  test('a reply to a reply stays at depth 2 under the same root', async () => {
    const alice = await registerUser(app);
    const root = await post(alice, { body: 'root' });
    const first = await post(alice, { body: 'reply', replyToId: root.id });
    const nested = await post(alice, { body: 'nested', replyToId: first.id });

    assert.equal(nested.rootId, root.id, 'thread went deeper than 2');

    const res = await send(alice, 'GET', `/api/posts/${root.id}/replies`);
    assert.equal(JSON.parse(res.body).posts.length, 2);
  });

  test('a blocked replier is hidden inside the thread too', async () => {
    // Otherwise blocking is defeated by replying to something you can see.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const root = await post(alice, { body: 'root' });
    await post(bob, { body: 'from bob', replyToId: root.id });

    await send(alice, 'POST', `/api/users/${bob.id}/block`, {});

    const res = await send(alice, 'GET', `/api/posts/${root.id}/replies`);
    assert.equal(JSON.parse(res.body).posts.length, 0);
  });

  test('the thread of an invisible root is a 404, not an empty list', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const root = await post(alice, { body: 'root' });
    await send(bob, 'POST', `/api/users/${alice.id}/block`, {});

    const res = await send(bob, 'GET', `/api/posts/${root.id}/replies`);
    assert.equal(res.statusCode, 404);
  });
});

describe('profiles', () => {
  test('a profile carries follower counts and the viewer\'s relationship', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await send(bob, 'POST', `/api/users/${alice.id}/follow`);

    const res = await send(bob, 'GET', `/api/users/${alice.username}/profile`);
    const { profile } = JSON.parse(res.body);
    assert.equal(profile.followersCount, 1);
    assert.equal(profile.following, true);
    assert.equal(profile.muted, false);
  });

  test('a profile shows only that author\'s top-level posts', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const root = await post(alice, { body: 'alice top level' });
    await post(alice, { body: 'alice reply', replyToId: root.id });
    await post(bob, { body: 'bob post' });

    const res = await send(bob, 'GET', `/api/users/${alice.username}/posts`);
    const bodies = JSON.parse(res.body).posts.map((p) => p.body);
    assert.deepEqual(bodies, ['alice top level']);
  });

  test('kind=replies returns the replies the posts view hides', async () => {
    // A reply used to be unreachable from anywhere once it left its thread:
    // the timeline holds only top-level posts and the profile filtered
    // replies out, so a comment you made could not be found again at all.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const root = await post(bob, { body: 'bob asks something' });
    await post(alice, { body: 'alice top level' });
    await post(alice, { body: 'alice answers', replyToId: root.id });

    const res = await send(bob, 'GET', `/api/users/${alice.username}/posts?kind=replies`);
    const bodies = JSON.parse(res.body).posts.map((p) => p.body);
    assert.deepEqual(bodies, ['alice answers'], 'only replies, and only hers');

    // And the default is unchanged — the two views stay disjoint, so nothing
    // appears in both.
    const other = await send(bob, 'GET', `/api/users/${alice.username}/posts`);
    assert.deepEqual(JSON.parse(other.body).posts.map((p) => p.body), ['alice top level']);
  });

  test('the Top tab ranks by likes and omits posts with none', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const quiet = await post(alice, { body: 'nobody liked this' });
    const popular = await post(alice, { body: 'the popular one' });
    await send(bob, 'POST', `/api/posts/${popular.id}/like`, {});

    const res = await send(bob, 'GET', '/api/posts/timeline?tab=top');
    const bodies = JSON.parse(res.body).posts.map((p) => p.body);

    // Zero-like posts are excluded — including them makes Top identical to
    // Global with the order shuffled.
    assert.deepEqual(bodies, ['the popular one']);
    assert.ok(quiet.id);
  });

  test('Top reports no more pages, because it cannot be paged soundly', async () => {
    // Ordering by a value that changes while you read makes keyset pagination
    // unsound: a post gaining likes between pages is served twice, one losing
    // them is skipped. The client must not try.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'liked' });
    await send(bob, 'POST', `/api/posts/${p.id}/like`, {});

    const res = JSON.parse((await send(bob, 'GET', '/api/posts/timeline?tab=top')).body);
    assert.equal(res.hasMore, false);
    assert.equal(res.nextCursor, null);
  });

  test('a quote post carries both the comment and the reference', async () => {
    // The server has accepted these together since the feature shipped; only
    // the client never sent a body, so quoting was impossible for no reason.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const original = await post(alice, { body: 'the original' });

    const quote = await post(bob, { body: 'my take on this', repostOfId: original.id });

    assert.equal(quote.body, 'my take on this');
    assert.equal(quote.repostOfId, original.id);
  });

  test('a blocked user cannot enumerate your follower list', async () => {
    // /profile 404s for a blocked viewer on the stated grounds that a profile
    // rendering for someone you blocked is a hole in the block. The follow
    // lists are the more sensitive half of a profile, not the less, and had no
    // check at all — the endpoint shipped with follows and nothing called it
    // until the client grew a way in.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    await send(carol, 'POST', `/api/users/${alice.id}/follow`, {});
    assert.equal(
      JSON.parse((await send(bob, 'GET', `/api/users/${alice.id}/followers`)).body).users.length,
      1, 'precondition: visible before the block'
    );

    await send(alice, 'POST', `/api/users/${bob.id}/block`, {});

    for (const direction of ['followers', 'following']) {
      const res = await send(bob, 'GET', `/api/users/${alice.id}/${direction}`);
      assert.equal(res.statusCode, 404, `${direction} must 404 for a blocked viewer`);
    }
  });

  test('a blocked account does not appear inside someone else\'s follower list', async () => {
    // Otherwise the block is avoidable by looking at any mutual connection.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    await send(bob, 'POST', `/api/users/${carol.id}/follow`, {});
    await send(alice, 'POST', `/api/users/${carol.id}/follow`, {});

    const before = JSON.parse((await send(alice, 'GET', `/api/users/${carol.id}/followers`)).body);
    assert.equal(before.users.length, 2, 'precondition');

    await send(alice, 'POST', `/api/users/${bob.id}/block`, {});

    const after = JSON.parse((await send(alice, 'GET', `/api/users/${carol.id}/followers`)).body);
    assert.deepEqual(after.users.map((u) => u.username), [alice.username]);
  });

  test('blocking prevents a follow, and says so as a 404', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await send(alice, 'POST', `/api/users/${bob.id}/block`, {});

    // 404 rather than 403: a distinguishable answer would confirm the block.
    const res = await send(bob, 'POST', `/api/users/${alice.id}/follow`, {});
    assert.equal(res.statusCode, 404);

    // And nothing was written — the earlier shape reported success here while
    // recording nothing, so the client showed "Following" over an empty table.
    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM follows');
    assert.equal(rows[0].n, 0);
  });

  test('a blocked user\'s profile is a 404', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await send(bob, 'POST', `/api/users/${alice.id}/block`, {});

    const res = await send(bob, 'GET', `/api/users/${alice.username}/profile`);
    assert.equal(res.statusCode, 404);
  });
});

describe('the per-author page cap', () => {
  test('one prolific author cannot own a page of the global tab', async () => {
    // Without this, an account posting in a loop takes the whole feed, and no
    // rate limit low enough to stop that is high enough for real use.
    const spammer = await registerUser(app);
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    for (let i = 0; i < 8; i += 1) await post(spammer, { body: `spam ${i}` });
    await post(alice, { body: 'from alice' });
    await post(bob, { body: 'from bob' });

    const { posts } = await timeline(alice, '?limit=6');
    const bySpammer = posts.filter((p) => p.username === spammer.username);
    assert.ok(bySpammer.length <= 2, `spammer took ${bySpammer.length} slots`);
    assert.ok(
      posts.some((p) => p.username === alice.username),
      'other authors were crowded out'
    );
  });

  test('the Following tab is not capped — it is self-curated', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    for (let i = 0; i < 5; i += 1) await post(alice, { body: `alice ${i}` });
    await send(bob, 'POST', `/api/users/${alice.id}/follow`);

    const { posts } = await timeline(bob, '?tab=following&limit=5');
    assert.equal(posts.length, 5, 'the Following tab dropped posts you asked to see');
  });

  test('a low-volume author is still reachable past a prolific one', async () => {
    // The cap drops posts rather than deferring them, so Global is a sampled
    // view. What must hold is that the sampling never buries a quiet author
    // behind a loud one, and that walking the pages terminates.
    const spammer = await registerUser(app);
    const alice = await registerUser(app);
    for (let i = 0; i < 6; i += 1) await post(spammer, { body: `spam ${i}` });
    await post(alice, { body: 'needle' });

    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 12; page += 1) {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await timeline(alice, q);
      body.posts.forEach((p) => seen.add(p.body));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    assert.ok(seen.has('needle'), 'a low-volume author was never reached');
  });
});
