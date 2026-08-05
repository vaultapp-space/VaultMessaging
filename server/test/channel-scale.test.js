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

// ============================================================
// Channel fanout scale
// ============================================================
// The load check the plan called for, run against the property rather than
// against a stopwatch: **a post must cost the same regardless of how many
// subscribers a channel has.**
//
// Timing assertions in CI are flaky and prove little on a shared runner. What
// actually matters is the write count, and that is exact and reproducible: if
// a post ever starts writing per-subscriber rows, one post to a large channel
// becomes hundreds of thousands of inserts, and this catches it at any size.
//
// Subscribers are inserted directly. Registering 10,000 accounts through the
// API would take minutes and test the registration path, not this one.

async function seedSubscribers(chatId, count) {
  await harness.store.pool.query(
    `INSERT INTO users (id, username, password_hash, identity_key, signed_prekey,
                        prekey_sig, salt)
     SELECT gen_random_uuid(), 'sub' || g || '_' || floor(random() * 1e9)::bigint,
            '', '', '', '', ''
       FROM generate_series(1, $1) g`,
    [count]
  );
  await harness.store.pool.query(
    `INSERT INTO channel_subscribers (chat_id, user_id)
     SELECT $1, id FROM users WHERE username LIKE 'sub%'
     ON CONFLICT DO NOTHING`,
    [chatId]
  );
}

describe('channel fanout scale', () => {
  test('a post writes O(1) rows at 10,000 subscribers', async () => {
    const owner = await registerUser(app);
    const channel = (await app.inject({
      method: 'POST', url: '/api/channels',
      headers: { cookie: owner.cookie },
      payload: { title: 'Big', username: `big${Date.now().toString(36)}` },
    })).json();

    await seedSubscribers(channel.id, 10_000);
    assert.equal(await harness.store.channels.subscriberCount(channel.id), 10_000);

    const before = await harness.store.pool.query(
      `SELECT
         (SELECT count(*) FROM messages)     AS messages,
         (SELECT count(*) FROM user_updates) AS updates`
    );

    const posted = await app.inject({
      method: 'POST', url: `/api/channels/${channel.id}/posts`,
      headers: { cookie: owner.cookie }, payload: { body: 'to ten thousand' },
    });
    assert.equal(posted.statusCode, 201, posted.body);

    const after = await harness.store.pool.query(
      `SELECT
         (SELECT count(*) FROM messages)     AS messages,
         (SELECT count(*) FROM user_updates) AS updates`
    );

    assert.equal(
      Number(after.rows[0].messages) - Number(before.rows[0].messages), 1,
      'exactly one message row, whatever the audience'
    );
    assert.equal(
      Number(after.rows[0].updates) - Number(before.rows[0].updates), 0,
      'and not one update row per subscriber — this is the whole design'
    );
  });

  test('reading a channel does not scan the subscriber table per post', async () => {
    // The other half: a feed that counted subscribers per post would be
    // O(posts x subscribers) on every open.
    const owner = await registerUser(app);
    const channel = (await app.inject({
      method: 'POST', url: '/api/channels',
      headers: { cookie: owner.cookie },
      payload: { title: 'Busy', username: `busy${Date.now().toString(36)}` },
    })).json();

    await seedSubscribers(channel.id, 2_000);
    for (let i = 0; i < 20; i++) {
      await app.inject({
        method: 'POST', url: `/api/channels/${channel.id}/posts`,
        headers: { cookie: owner.cookie }, payload: { body: `post ${i}` },
      });
    }

    const started = Date.now();
    const res = await app.inject({
      method: 'GET', url: `/api/channels/${channel.id}/posts`,
      headers: { cookie: owner.cookie },
    });
    const elapsed = Date.now() - started;

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().posts.length, 20);
    // Deliberately loose. This is a smoke bound to catch an accidental
    // per-post subscriber scan, not a performance target — a tight number
    // here would just be a flaky test on a shared runner.
    assert.ok(elapsed < 5000, `feed read took ${elapsed}ms`);
  });

  test('subscriber lookup is paged, not materialised whole', async () => {
    // Returning a million ids in one array to iterate them is how a single
    // post takes the process down.
    const owner = await registerUser(app);
    const channel = (await app.inject({
      method: 'POST', url: '/api/channels',
      headers: { cookie: owner.cookie },
      payload: { title: 'Paged', username: `pg${Date.now().toString(36)}` },
    })).json();

    await seedSubscribers(channel.id, 3_000);

    const page = await harness.store.channels.subscriberPage(channel.id, { limit: 1000 });
    assert.equal(page.length, 1000, 'the page limit is respected');

    const next = await harness.store.channels.subscriberPage(channel.id, {
      after: page[page.length - 1], limit: 1000,
    });
    assert.equal(next.length, 1000);
    assert.ok(next[0] > page[page.length - 1], 'the cursor advances');
  });
});
