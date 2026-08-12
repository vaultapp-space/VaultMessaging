import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';
import { createFeedTicker, FEED_KEY } from '../src/realtime/feed-ticker.js';

// Realtime for the public feed. Two properties are being guarded, and they are
// the two that a "just push the post" implementation would break:
//
//   1. A tick carries no post. The server cannot filter per viewer at publish
//      time without O(viewers) work, so a pushed body would arrive at people
//      who blocked its author. "The client hid it" is not blocking.
//   2. A post costs one publish regardless of how many people follow or watch.

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

/** A fanout stand-in that records what it was asked to deliver. */
function recordingFanout() {
  const calls = [];
  return {
    calls,
    async deliverToChannel(key, message) {
      calls.push({ key, message });
    },
  };
}

describe('the feed ticker', () => {
  test('coalesces a burst into a single tick', async () => {
    const fanout = recordingFanout();
    const ticker = createFeedTicker({ fanout, windowMs: 20 });

    // A thousand posts inside one window is the case that matters: without
    // coalescing this is a thousand socket messages per viewer, each saying
    // exactly what the first one said.
    for (let i = 0; i < 1000; i += 1) ticker.notePost();
    await ticker.stop();

    assert.equal(fanout.calls.length, 1);
    assert.equal(fanout.calls[0].key, FEED_KEY);
  });

  test('the tick carries no post content', async () => {
    const fanout = recordingFanout();
    const ticker = createFeedTicker({ fanout, windowMs: 20 });

    ticker.notePost();
    await ticker.stop();

    const { message } = fanout.calls[0];
    assert.deepEqual(message, { type: 'feed_tick' });
    // Spelled out rather than left to deepEqual: these are the keys someone
    // adds when "the client has to refetch" starts to feel wasteful, and each
    // one leaks an author's activity to people who blocked them.
    for (const leak of ['body', 'post', 'posts', 'authorId', 'username', 'media']) {
      assert.equal(leak in message, false, `feed_tick must not carry ${leak}`);
    }
  });

  test('a window with no posts emits nothing', async () => {
    const fanout = recordingFanout();
    const ticker = createFeedTicker({ fanout, windowMs: 20 });

    await ticker.stop();

    assert.equal(fanout.calls.length, 0);
  });

  test('a failing fanout never propagates to the caller', async () => {
    const ticker = createFeedTicker({
      fanout: { async deliverToChannel() { throw new Error('bus down'); } },
      windowMs: 20,
    });

    ticker.notePost();
    // The post itself already succeeded by the time this runs. A throw here
    // would surface as a failed request for something that worked.
    await ticker.stop();
  });
});

describe('posting and the tick', () => {
  test('a post ticks once, a reply does not tick at all', async () => {
    const alice = await registerUser(app);
    const seen = [];
    // Swap in a recorder around the real ticker's fanout dependency by
    // observing the app's ticker through the route path.
    const original = app.feedTicker.notePost;
    app.feedTicker.notePost = () => { seen.push('tick'); };

    const res = await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'hello world' },
    });
    assert.equal(res.statusCode, 201);
    const post = JSON.parse(res.body).post;

    await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'a reply', replyToId: post.id },
    });

    app.feedTicker.notePost = original;

    // A reply is not a timeline event — it will not appear in the feed the
    // banner invites people to refresh, so ticking for it refreshes every open
    // feed for nothing.
    assert.deepEqual(seen, ['tick']);
  });

  test('one post is one publish no matter how many followers the author has', async () => {
    const alice = await registerUser(app);
    const { rows: [author] } = await harness.store.pool.query(
      'SELECT id FROM users WHERE username = $1', [alice.username]
    );

    // Seeded directly: registering 5,000 accounts through the API would take
    // minutes and exercise the registration path rather than this one.
    await harness.store.pool.query(
      `INSERT INTO users (id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt)
       SELECT gen_random_uuid(), 'follower' || g, 'x', 'x', 'x', 'x', 'x'
         FROM generate_series(1, 5000) g`
    );
    await harness.store.pool.query(
      `INSERT INTO follows (follower_id, followee_id)
       SELECT id, $1 FROM users WHERE username LIKE 'follower%'`,
      [author.id]
    );

    let ticks = 0;
    const original = app.feedTicker.notePost;
    app.feedTicker.notePost = () => { ticks += 1; };

    await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'to five thousand people' },
    });

    app.feedTicker.notePost = original;

    // The invariant: no per-follower work on the write path. If a future
    // feature (notifications, most likely) starts iterating followers here,
    // this is what catches it — at any follower count.
    assert.equal(ticks, 1);

    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM posts');
    assert.equal(rows[0].n, 1, 'one post row, not one per follower');
  });
});
