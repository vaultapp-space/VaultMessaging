import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// The media ledger (migration 0020). What is being guarded is a leak, not a
// feature: before this, a file uploaded through POST /api/media/upload and
// never referenced by anything was deleted by nothing and — because
// canViewMediaFile is deny-by-exception — served to any authenticated user
// forever.
//
// The tests that matter most are the two negative ones. Deleting an orphan is
// easy; not deleting a file that is still in use is where a sweep like this
// does real damage.

let harness;
let app;
let mediaDir;

// A one-pixel PNG. Real bytes rather than random ones so the upload route's
// allowlist is exercised the way a client would.
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

async function upload(user) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/media/upload',
    headers: { cookie: user.cookie },
    payload: { mimeType: 'image/png', data: PNG_BASE64 },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).fileId;
}

/** Backdate a ledger row past the grace period without waiting an hour. */
async function age(fileId) {
  await harness.store.pool.query(
    `UPDATE media_files SET created_at = now() - interval '2 hours' WHERE file_id = $1`,
    [fileId]
  );
}

function fileExists(fileId) {
  return fs.existsSync(path.join(mediaDir, `${fileId}.png`));
}

async function ledgerRow(fileId) {
  const { rows } = await harness.store.pool.query(
    'SELECT * FROM media_files WHERE file_id = $1',
    [fileId]
  );
  return rows[0] ?? null;
}

describe('the media ledger', () => {
  test('an upload is recorded, unclaimed, with its real extension', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    const row = await ledgerRow(fileId);
    assert.ok(row, 'upload should have written a ledger row');
    assert.equal(row.claimed_at, null);
    assert.equal(row.extension, '.png');
    assert.ok(fileExists(fileId));

    // Attribution is the point of storing uploader_id: it is what lets an
    // abusive file be traced to an account when the only evidence is a URL.
    const { rows: [author] } = await harness.store.pool.query(
      'SELECT id FROM users WHERE username = $1',
      [alice.username]
    );
    assert.equal(row.uploader_id, author.id);
  });

  test('referencing a file in a post claims it', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'with a picture', media: { fileId, mimeType: 'image/png' } },
    });

    const row = await ledgerRow(fileId);
    assert.notEqual(row.claimed_at, null, 'posting should have claimed the file');
  });
});

describe('the orphan sweep', () => {
  test('deletes an unclaimed upload past the grace period, file and row', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);
    await age(fileId);

    await harness.store.reap();

    assert.equal(fileExists(fileId), false, 'the file should be off the disk');
    assert.equal(await ledgerRow(fileId), null, 'the ledger row should be gone');
  });

  test('leaves a recent unclaimed upload alone', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    // Not aged: this is the composer that is still open. Reaping it here would
    // delete the image out from under someone mid-post.
    await harness.store.reap();

    assert.ok(fileExists(fileId), 'a fresh upload is not an orphan');
    assert.ok(await ledgerRow(fileId));
  });

  test('leaves a file that content still references, even if the claim never happened', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'with a picture', media: { fileId, mimeType: 'image/png' } },
    });

    // Simulate a caller that referenced the file but forgot to claim it — the
    // failure mode a future content type is most likely to have. The NOT EXISTS
    // clauses in listOrphans are the safety net, and this is what tests them:
    // without them, aging the row would delete a live post's image.
    await harness.store.pool.query(
      'UPDATE media_files SET claimed_at = NULL WHERE file_id = $1',
      [fileId]
    );
    await age(fileId);

    await harness.store.reap();

    assert.ok(fileExists(fileId), 'a referenced file must survive a missed claim');
  });

  test('never touches a file with no ledger row', async () => {
    // Everything uploaded before migration 0020 is in this state. A sweep that
    // worked by listing the directory would delete every sticker on the
    // instance; this one walks the table, so an unknown file is invisible to it.
    const strayId = '00000000-0000-4000-8000-00000000beef';
    fs.writeFileSync(path.join(mediaDir, `${strayId}.png`), Buffer.from(PNG_BASE64, 'base64'));

    await harness.store.reap();

    assert.ok(fileExists(strayId), 'a file the ledger does not know about is not the sweep\'s business');
    fs.unlinkSync(path.join(mediaDir, `${strayId}.png`));
  });

  test('survives content whose fileId is not a uuid', async () => {
    // The story media schema is additionalProperties:true with no format check
    // on fileId, so a client may put any string there. Both claim() and
    // forget() feed that value at a uuid column. This is a reaper-wide hazard
    // rather than a cosmetic one: an exception inside reap() aborts the pass,
    // and fifteen minutes of aborted passes is a 503 on /health.
    const alice = await registerUser(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie: alice.cookie },
      payload: { media: { fileId: 'not-a-uuid', mimeType: 'image/png' }, privacy: 'everyone' },
    });
    assert.equal(created.statusCode, 201, created.body);

    await harness.store.pool.query(`UPDATE stories SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    const { rows } = await harness.store.pool.query('SELECT count(*)::int AS n FROM stories');
    assert.equal(rows[0].n, 0, 'the pass should have completed and collected the story');
  });

  test('forgets the ledger row when the post that claimed the file expires', async () => {
    const alice = await registerUser(app);
    const fileId = await upload(alice);

    await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie: alice.cookie },
      payload: { body: 'with a picture', media: { fileId, mimeType: 'image/png' } },
    });

    await harness.store.pool.query(`UPDATE posts SET expires_at = now() - interval '1 minute'`);
    await harness.store.reap();

    // The post reaper takes the file; the ledger row describes nothing after
    // that, and a claimed row is never otherwise removed — so without this the
    // table would grow for the life of the instance.
    assert.equal(fileExists(fileId), false);
    assert.equal(await ledgerRow(fileId), null);
  });
});
