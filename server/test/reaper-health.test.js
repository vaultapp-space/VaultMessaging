import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, truncateAll } from './helpers/harness.js';

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
  // Reaper state lives in the process, not the database, so truncating does
  // not reset it and counters would otherwise accumulate across tests.
  Object.assign(app.reaperState, {
    lastSuccessAt: null, lastError: null, runs: 0, rowsDeletedTotal: 0,
  });
});

// ============================================================
// Reaper health
// ============================================================
// The reaper is the only thing bounding database size *and* the only thing
// enforcing the 24-hour rule. Its failure mode is silent: nothing breaks for
// a day, then storage climbs and messages quietly outlive their expiry, with
// no user-visible symptom.
//
// So a stall has to fail /health with a non-2xx, not merely set a flag — a
// monitor reading only the status code must not report green through exactly
// the outage that matters.

describe('reaper health', () => {
  test('a fresh instance is healthy before its first pass', async () => {
    // Boot counts as the baseline, or every restart would look like a stall
    // for the length of one interval.
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reaper.healthy, true);
  });

  test('a successful pass is recorded', async () => {
    app.recordReaperRun({ rowsDeleted: 7 });

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.reaper.runs, 1);
    assert.equal(body.reaper.rowsDeletedTotal, 7);
    assert.ok(body.reaper.lastSuccessAt, 'the timestamp is reported');
    assert.equal(body.reaper.lastError, null);
  });

  test('an idle pass still counts as healthy', async () => {
    // A quiet hour with nothing to delete is a working reaper, not silence.
    app.recordReaperRun({ rowsDeleted: 0 });

    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reaper.healthy, true);
  });

  test('a failing pass records the error but does not advance success', async () => {
    app.recordReaperRun({ rowsDeleted: 3 });
    const afterSuccess = (await app.inject({ method: 'GET', url: '/health' })).json();

    app.recordReaperRun({ error: new Error('connection reset') });
    const afterFailure = (await app.inject({ method: 'GET', url: '/health' })).json();

    assert.equal(afterFailure.reaper.lastError, 'connection reset');
    assert.equal(
      afterFailure.reaper.lastSuccessAt, afterSuccess.reaper.lastSuccessAt,
      'a failed pass must not look like a successful one'
    );
    assert.equal(afterFailure.reaper.runs, 2, 'but it is still a run');
  });

  test('a stalled reaper fails /health with 503', async () => {
    // The assertion the whole feature rests on. 200-with-a-flag would let an
    // uptime check report green while the retention guarantee was not being
    // enforced.
    app.reaperState.lastSuccessAt = Date.now() - 20 * 60 * 1000;

    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.reaper.healthy, false);
    assert.ok(body.reaper.secondsSinceLastSuccess >= 1200);
  });

  test('health recovers once the reaper runs again', async () => {
    app.reaperState.lastSuccessAt = Date.now() - 20 * 60 * 1000;
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 503);

    app.recordReaperRun({ rowsDeleted: 1 });
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  });
});
