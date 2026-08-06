import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp } from './helpers/harness.js';

let harness;
let app;

before(async () => {
  harness = await createTestApp();
  app = harness.app;
});

after(async () => {
  await harness.close();
});

// The origin allowlist (server/src/app.js isOriginAllowed) is shared by the
// CORS layer and the WebSocket route's own check, so getting it wrong either
// breaks a real client or widens who can make credentialed requests. This
// only covers the literal-origin entries — the isDev localhost widening is
// exercised by ws.routes.test.js instead.
describe('CORS origin allowlist', () => {
  test('the Android app origin (client/capacitor.config.ts) is allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/salt/nobody',
      headers: { origin: 'https://app.vaultapp.space' },
    });
    assert.equal(res.headers['access-control-allow-origin'], 'https://app.vaultapp.space');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  test('an unrelated origin is not allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/salt/nobody',
      headers: { origin: 'https://evil.example' },
    });
    assert.notEqual(res.headers['access-control-allow-origin'], 'https://evil.example');
  });
});
