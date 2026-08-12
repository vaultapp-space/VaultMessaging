import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Thoughts phase 3: moderation. The posture is "nothing is removed for being
// disagreeable, only for being illegal", so most of what is worth asserting is
// about restraint — that the operator surface is narrow, invisible to everyone
// else, and that a takedown actually stops the bytes being served.

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

const send = (user, method, url, payload) => app.inject({
  method, url, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}),
});

async function post(user, payload) {
  const res = await send(user, 'POST', '/api/posts', payload);
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).post;
}

async function makeOperator(user) {
  await harness.store.pool.query('UPDATE users SET is_operator = true WHERE id = $1', [user.id]);
  return user;
}

// A real file on disk, so takedown can be shown to actually unlink it.
async function uploadMedia(user) {
  // 1x1 transparent PNG.
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const res = await send(user, 'POST', '/api/media/upload', { mimeType: 'image/png', data });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body);
}

describe('reporting', () => {
  test('a report is accepted and appears in the operator queue', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'reported content' });

    const res = await send(bob, 'POST', `/api/posts/${p.id}/report`, { category: 'other_illegal' });
    assert.equal(res.statusCode, 204, res.body);

    const queue = JSON.parse((await send(op, 'GET', '/api/moderation/reports')).body);
    assert.equal(queue.reports.length, 1);
    assert.equal(queue.reports[0].postId, p.id);
    assert.equal(queue.reports[0].reportCount, 1);
  });

  test('the category enum is the content policy — anything else is refused', async () => {
    // If the form accepted "offensive", the product would be promising a
    // review it has said it will not perform.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const p = await post(alice, { body: 'disagreeable but legal' });

    const res = await send(bob, 'POST', `/api/posts/${p.id}/report`, { category: 'offensive' });
    assert.equal(res.statusCode, 400, res.body);
  });

  test('reporting twice does not inflate the count', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'spam' });

    await send(bob, 'POST', `/api/posts/${p.id}/report`, { category: 'other_illegal' });
    const second = await send(bob, 'POST', `/api/posts/${p.id}/report`, { category: 'terrorism' });
    // Deliberately still 204 — telling a reporter "you already did that" is
    // noise, and confirming it leaks whether an account reported something.
    assert.equal(second.statusCode, 204);

    const queue = JSON.parse((await send(op, 'GET', '/api/moderation/reports')).body);
    assert.equal(queue.reports[0].reportCount, 1);
  });

  test('multiple reporters group into one queue entry', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'widely reported' });

    for (let i = 0; i < 3; i += 1) {
      const reporter = await registerUser(app);
      await send(reporter, 'POST', `/api/posts/${p.id}/report`, { category: 'csam' });
    }

    const queue = JSON.parse((await send(op, 'GET', '/api/moderation/reports')).body);
    assert.equal(queue.reports.length, 1, 'the queue should group by post, not by report');
    assert.equal(queue.reports[0].reportCount, 3);
  });
});

describe('the operator surface is invisible to everyone else', () => {
  test('a non-operator gets 404, not 403, from every moderation route', async () => {
    // 403 would confirm the routes exist and that operators are a thing, which
    // is the first step in looking for a way to become one.
    const bob = await registerUser(app);
    const alice = await registerUser(app);
    const p = await post(alice, { body: 'target' });

    const queue = await send(bob, 'GET', '/api/moderation/reports');
    assert.equal(queue.statusCode, 404);

    const remove = await send(bob, 'POST', `/api/moderation/posts/${p.id}/remove`, {});
    assert.equal(remove.statusCode, 404);

    const block = await send(bob, 'POST',
      `/api/moderation/users/${alice.id}/posting-block`, { days: 1 });
    assert.equal(block.statusCode, 404);

    // And nothing actually happened.
    const still = await send(alice, 'GET', `/api/posts/${p.id}`);
    assert.equal(still.statusCode, 200);
  });

  test('an unauthenticated caller gets 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/moderation/reports' });
    assert.equal(res.statusCode, 401);
  });
});

describe('takedown', () => {
  test('removes the content, keeps a tombstone, and drops it from the timeline', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'illegal content' });

    const res = await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`,
      { category: 'csam', reason: 'reported' });
    assert.equal(res.statusCode, 204, res.body);

    const timeline = JSON.parse((await send(alice, 'GET', '/api/posts/timeline')).body);
    assert.equal(timeline.posts.length, 0);

    const gone = await send(alice, 'GET', `/api/posts/${p.id}`);
    assert.equal(gone.statusCode, 404);

    // The row survives so reports resolve against it, but holds no content.
    const { rows } = await harness.store.pool.query(
      'SELECT body, media, removed_at FROM posts WHERE id = $1', [p.id]
    );
    assert.equal(rows.length, 1, 'the tombstone should remain until the reaper');
    assert.equal(rows[0].body, null);
    assert.ok(rows[0].removed_at);
    // media is deliberately NOT nulled — canViewMediaFile needs the fileId to
    // deny the file. See removePost.
  });

  test('the image is unlinked from disk, not just detached from the row', async () => {
    // The whole point. A row edit that leaves the file being served has not
    // taken anything down.
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const { fileId } = await uploadMedia(alice);
    const p = await post(alice, { media: { fileId, mimeType: 'image/png' } });

    const filePath = path.join(harness.store.uploadsDir, 'media', `${fileId}.png`);
    assert.ok(fs.existsSync(filePath), 'precondition: the upload should be on disk');

    await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`, { category: 'csam' });

    assert.equal(fs.existsSync(filePath), false, 'the file is still being served');
  });

  test('media of a removed post is refused even if the file survives', async () => {
    // Second line of defence, for the window before the unlink lands and for
    // any file the extension probe missed.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const { fileId } = await uploadMedia(alice);
    const p = await post(alice, { media: { fileId, mimeType: 'image/png' } });

    const before = await send(bob, 'GET', `/api/media/${fileId}`);
    assert.equal(before.statusCode, 200, 'precondition: public post media is readable');

    await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`, { category: 'csam' });

    // Put the bytes back, to prove authorization refuses independently of the
    // unlink having worked.
    fs.writeFileSync(path.join(harness.store.uploadsDir, 'media', `${fileId}.png`), 'x');

    const after = await send(bob, 'GET', `/api/media/${fileId}`);
    assert.equal(after.statusCode, 404, 'removed media is still being served');
  });

  test('an action is recorded that outlives the post', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'gone soon' });

    await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`, { category: 'terrorism' });

    // The reaper takes the tombstone; the audit row must not go with it, which
    // is why moderation_actions.post_id is not a foreign key.
    await harness.store.pool.query(`UPDATE posts SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      'SELECT action, category, author_id, operator_id FROM moderation_actions WHERE post_id = $1',
      [p.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'post_removed');
    assert.equal(rows[0].category, 'terrorism');
    assert.equal(rows[0].author_id, alice.id);
    assert.equal(rows[0].operator_id, op.id);
  });

  test('removing an already-removed post is a 404', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    const p = await post(alice, { body: 'once' });

    await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`, {});
    const again = await send(op, 'POST', `/api/moderation/posts/${p.id}/remove`, {});
    assert.equal(again.statusCode, 404);
  });
});

describe('posting blocks', () => {
  test('a blocked author cannot post but can still read and follow', async () => {
    // The sanction is on publishing, not on existing.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    await post(bob, { body: 'from bob' });

    await send(op, 'POST', `/api/moderation/users/${alice.id}/posting-block`,
      { days: 7, reason: 'repeat illegal content' });

    const blocked = await send(alice, 'POST', '/api/posts', { body: 'let me through' });
    assert.equal(blocked.statusCode, 403, blocked.body);

    const timeline = await send(alice, 'GET', '/api/posts/timeline');
    assert.equal(timeline.statusCode, 200, 'a posting block should not stop reading');

    const follow = await send(alice, 'POST', `/api/users/${bob.id}/follow`);
    assert.equal(follow.statusCode, 204, 'a posting block should not stop following');
  });

  test('a block can be lifted with days = 0', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));

    await send(op, 'POST', `/api/moderation/users/${alice.id}/posting-block`, { days: 7 });
    assert.equal((await send(alice, 'POST', '/api/posts', { body: 'nope' })).statusCode, 403);

    await send(op, 'POST', `/api/moderation/users/${alice.id}/posting-block`, { days: 0 });
    assert.equal((await send(alice, 'POST', '/api/posts', { body: 'back' })).statusCode, 201);
  });

  test('an expired block stops applying on its own', async () => {
    const alice = await registerUser(app);
    const op = await makeOperator(await registerUser(app));
    await send(op, 'POST', `/api/moderation/users/${alice.id}/posting-block`, { days: 1 });

    await harness.store.pool.query(
      `UPDATE users SET posting_blocked_until = now() - interval '1 hour' WHERE id = $1`,
      [alice.id]
    );

    assert.equal((await send(alice, 'POST', '/api/posts', { body: 'served my time' })).statusCode, 201);
  });
});
