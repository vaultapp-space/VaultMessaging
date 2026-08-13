import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// Deleting an account. The dangerous part is not the row — almost everything
// cascades — it is the media: posts, stories and the media ledger all cascade
// from users and all reference files on disk, and a cascade-deleted row is
// never seen by DELETE ... RETURNING. Delete the user first and those files
// become unreachable by anything, forever, while still being served.

let harness;
let app;
let mediaDir;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  harness = await createTestApp();
  app = harness.app;
  mediaDir = path.join(harness.store.uploadsDir, 'media');
});

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.store);
  await harness.store.redis.flushdb();
});

function del(user, password) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/delete-account',
    headers: { cookie: user.cookie },
    payload: { password },
  });
}

async function upload(user) {
  const res = await app.inject({
    method: 'POST', url: '/api/media/upload',
    headers: { cookie: user.cookie },
    payload: { mimeType: 'image/png', data: PNG_BASE64 },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).fileId;
}

describe('deleting an account', () => {
  test('removes the account and its posts', async () => {
    const alice = await registerUser(app);
    await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: alice.cookie }, payload: { body: 'goodbye' },
    });

    const res = await del(alice, alice.password);
    assert.equal(res.statusCode, 200, res.body);

    const users = await harness.store.pool.query(
      'SELECT count(*)::int AS n FROM users WHERE username = $1', [alice.username]
    );
    assert.equal(users.rows[0].n, 0);
    const posts = await harness.store.pool.query('SELECT count(*)::int AS n FROM posts');
    assert.equal(posts.rows[0].n, 0, 'posts cascade');
  });

  test('takes the media off the disk with it', async () => {
    // The whole reason this route needed writing rather than being a one-line
    // DELETE. Without collecting first, these files outlive every row that
    // referenced them and nothing can ever find them again.
    const alice = await registerUser(app);
    const fileId = await upload(alice);
    await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'with a picture', media: { fileId, mimeType: 'image/png' } },
    });

    assert.ok(fs.existsSync(path.join(mediaDir, `${fileId}.png`)), 'precondition');

    await del(alice, alice.password);

    assert.equal(
      fs.existsSync(path.join(mediaDir, `${fileId}.png`)), false,
      'the file must not survive the account'
    );
  });

  test('an unclaimed upload is collected too', async () => {
    // Uploaded and never attached to anything. Its ledger row cascades with
    // the user, so the orphan sweep would lose the only record of it.
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    await del(alice, alice.password);

    assert.equal(fs.existsSync(path.join(mediaDir, `${fileId}.png`)), false);
  });

  test('the wrong password is refused and nothing is deleted', async () => {
    const alice = await registerUser(app);

    const res = await del(alice, 'not the right password at all');
    assert.equal(res.statusCode, 403);

    const users = await harness.store.pool.query(
      'SELECT count(*)::int AS n FROM users WHERE username = $1', [alice.username]
    );
    assert.equal(users.rows[0].n, 1, 'still there');
  });

  test('the session stops working immediately afterwards', async () => {
    const alice = await registerUser(app);
    await del(alice, alice.password);

    const after = await app.inject({
      method: 'GET', url: '/api/chats', headers: { cookie: alice.cookie },
    });
    assert.equal(after.statusCode, 401, 'the cookie must not outlive the account');
  });

  test('other accounts are untouched', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const bobFile = await upload(bob);
    await app.inject({
      method: 'POST', url: '/api/posts',
      headers: { cookie: bob.cookie },
      payload: { body: 'bob stays', media: { fileId: bobFile, mimeType: 'image/png' } },
    });

    await del(alice, alice.password);

    const posts = await harness.store.pool.query('SELECT body FROM posts');
    assert.deepEqual(posts.rows.map((r) => r.body), ['bob stays']);
    assert.ok(fs.existsSync(path.join(mediaDir, `${bobFile}.png`)), "bob's file stays");
  });
});
