import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

let harness;
let app;
let files;

before(async () => {
  harness = await createTestApp();
  app = harness.app;
  files = harness.store.attachments;
});

after(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.store);
  await harness.store.redis.flushdb();
});

const HOUR = 3600_000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

async function createFile(ownerId, { hours = 1, filename = 'a.png', mime = 'image/png' } = {}) {
  const { rows } = await harness.store.pool.query(
    `INSERT INTO files (filename, mime_type, total_chunks, owner_id, expires_at)
     VALUES ($1, $2, 1, $3, $4)
     RETURNING id, expires_at, ref_count, is_encrypted`,
    [filename, mime, ownerId, inHours(hours)]
  );
  return rows[0];
}

describe('file schema', () => {
  test('expires_at is NOT NULL — an upload cannot be permanent', async () => {
    // The 24h rule covers attachments exactly as it covers messages.
    const { rows } = await harness.store.pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'expires_at'`
    );
    assert.equal(rows[0].is_nullable, 'NO');
  });

  test('the attachments table no longer exists under its old name', async () => {
    const { rows } = await harness.store.pool.query(
      `SELECT to_regclass('public.attachments') AS old,
              to_regclass('public.files') AS current`
    );
    assert.equal(rows[0].old, null);
    assert.ok(rows[0].current);
  });

  test('new files default to encrypted with a single reference', async () => {
    // Everything today comes from the chunked E2EE path; a cloud file has to
    // opt out of that explicitly rather than by omission.
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    assert.equal(file.is_encrypted, true);
    assert.equal(file.ref_count, 1);
  });
});

describe('reference counting', () => {
  test('a forward adds a reference without re-uploading', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    const after = await files.addReference(file.id, inHours(2));

    assert.equal(after.ref_count, 2);
  });

  test('a forward extends the expiry to cover the new message', async () => {
    // Otherwise the forwarded copy would vanish when the original expired,
    // leaving a visible message pointing at bytes that are gone.
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: 1 });

    const after = await files.addReference(file.id, inHours(5));

    assert.ok(
      new Date(after.expires_at) > new Date(file.expires_at),
      'expiry moved forward to cover the newer reference'
    );
  });

  test('a forward never shortens the expiry', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: 10 });

    const after = await files.addReference(file.id, inHours(1));

    assert.equal(
      new Date(after.expires_at).getTime(),
      new Date(file.expires_at).getTime(),
      'a shorter-lived reference must not cut the file short for others'
    );
  });

  test('a chain of forwards cannot push a file past 24 hours', async () => {
    // The failure this clamp exists to prevent: forwarding repeatedly to
    // manufacture permanent storage.
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: 20 });

    let latest = file;
    for (let i = 0; i < 10; i += 1) {
      latest = await files.addReference(file.id, inHours(23));
    }

    const lifetimeMs = new Date(latest.expires_at) - Date.now();
    assert.ok(
      lifetimeMs <= 24 * HOUR + 5000,
      `expected <= 24h after 10 forwards, got ${Math.round(lifetimeMs / HOUR)}h`
    );
    assert.equal(latest.ref_count, 11);
  });

  test('releasing a reference decrements but never goes negative', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    await files.addReference(file.id, inHours(1));
    assert.equal((await files.releaseReference(file.id)).ref_count, 1);
    assert.equal((await files.releaseReference(file.id)).ref_count, 0);
    assert.equal((await files.releaseReference(file.id)).ref_count, 0, 'clamped at zero');
  });

  test('releasing does not delete the row — the reaper owns deletion', async () => {
    // Deleting here would orphan the bytes on disk, because only the reaper
    // removes chunk files.
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    await files.releaseReference(file.id);

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM files WHERE id = $1`, [file.id]
    );
    assert.equal(rows[0].n, 1);
  });

  test('referencing a file that does not exist returns null', async () => {
    assert.equal(await files.addReference(crypto.randomUUID(), inHours(1)), null);
  });
});

describe('content addressing', () => {
  test('finds an identical file already uploaded by the same owner', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);
    const hash = crypto.createHash('sha256').update('the bytes').digest('hex');

    await files.setMetadata(file.id, { sha256: hash, sizeBytes: 9 });

    const found = await files.findByHash(hash, alice.id);
    assert.equal(found.id, file.id);
  });

  test('does not match a file belonging to someone else', async () => {
    // Matching on hash alone would let anyone who guessed a hash reference a
    // file they never had access to.
    const alice = await registerUser(app);
    const mallory = await registerUser(app);
    const file = await createFile(alice.id);
    const hash = crypto.createHash('sha256').update('secret bytes').digest('hex');
    await files.setMetadata(file.id, { sha256: hash });

    assert.equal(await files.findByHash(hash, mallory.id), null);
  });

  test('does not match an expired file', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: -1 });
    const hash = crypto.createHash('sha256').update('stale').digest('hex');
    await files.setMetadata(file.id, { sha256: hash });

    assert.equal(await files.findByHash(hash, alice.id), null);
  });

  test('a null hash never matches', async () => {
    const alice = await registerUser(app);
    assert.equal(await files.findByHash(null, alice.id), null);
  });
});

describe('metadata', () => {
  test('stores dimensions, duration and size', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    const updated = await files.setMetadata(file.id, {
      sizeBytes: 12345, width: 1920, height: 1080, durationMs: 4200,
    });

    assert.equal(Number(updated.size_bytes), 12345);
    assert.equal(updated.width, 1920);
    assert.equal(updated.height, 1080);
    assert.equal(updated.duration_ms, 4200);
  });

  test('a partial update leaves other fields intact', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    await files.setMetadata(file.id, { width: 800, height: 600 });
    const updated = await files.setMetadata(file.id, { sizeBytes: 999 });

    assert.equal(updated.width, 800, 'width survived a later size-only update');
    assert.equal(Number(updated.size_bytes), 999);
  });

  test('a cloud file can be marked unencrypted', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id);

    const updated = await files.setMetadata(file.id, { isEncrypted: false });
    assert.equal(updated.is_encrypted, false);
  });
});

describe('reaping files', () => {
  test('an expired file is removed', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: -1 });

    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM files WHERE id = $1`, [file.id]
    );
    assert.equal(rows[0].n, 0);
  });

  test('a live file survives the reaper', async () => {
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: 5 });

    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM files WHERE id = $1`, [file.id]
    );
    assert.equal(rows[0].n, 1);
  });

  test('a forwarded file outlives the original message', async () => {
    // The end-to-end property reference counting exists for: the first
    // message expires, but a later chat still shows the file.
    const alice = await registerUser(app);
    const file = await createFile(alice.id, { hours: -1 });

    await files.addReference(file.id, inHours(3));
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM files WHERE id = $1`, [file.id]
    );
    assert.equal(rows[0].n, 1, 'the extended expiry kept it alive');
  });
});
