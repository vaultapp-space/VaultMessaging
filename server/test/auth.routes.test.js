import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp, registerUser, sessionCookie, truncateAll, fakeKeyMaterial } from './helpers/harness.js';
import config from '../src/config.js';

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

describe('POST /api/auth/register', () => {
  test('creates a user and sets an httpOnly session cookie', async () => {
    const material = fakeKeyMaterial();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'a-good-password', ...material },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.username, 'alice');
    assert.ok(body.id, 'returns a user id');
    assert.equal(body.salt, material.salt);
    assert.ok(!('password' in body), 'never echoes the password');
    assert.ok(!('password_hash' in body), 'never leaks the hash');

    const cookie = res.cookies.find((c) => c.name === config.cookieName);
    assert.ok(cookie, 'sets the session cookie');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
  });

  test('rejects a duplicate username with 409', async () => {
    await registerUser(app, { username: 'bob' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'another-password', ...fakeKeyMaterial() },
    });
    assert.equal(res.statusCode, 409);
  });

  test('rejects usernames outside the allowed charset', async () => {
    for (const username of ['has space', 'has-dash', 'has.dot', 'e√il']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'a-good-password', ...fakeKeyMaterial() },
      });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(username)}`);
    }
  });

  test('requires all key material', async () => {
    const material = fakeKeyMaterial();
    for (const missing of ['identityKey', 'signedPrekey', 'prekeySig', 'oneTimePrekeys', 'salt']) {
      const payload = { username: `u${missing}`, password: 'a-good-password', ...material };
      delete payload[missing];
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
      assert.equal(res.statusCode, 400, `expected 400 when ${missing} is absent`);
    }
  });

  test('stores the uploaded one-time prekeys', async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/keys/count',
      headers: { cookie: user.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, user.material.oneTimePrekeys.length);
  });
});

describe('POST /api/auth/login', () => {
  test('succeeds with the right password and returns the vault', async () => {
    const user = await registerUser(app);
    await app.inject({
      method: 'POST',
      url: '/api/auth/vault',
      headers: { cookie: user.cookie },
      payload: { encryptedVault: 'vault-blob' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: user.username, password: user.password },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().encryptedVault, 'vault-blob');
    assert.ok(sessionCookie(res), 'issues a fresh session');
  });

  test('rejects a wrong password with 401', async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: user.username, password: 'not-the-password' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('returns the same error for unknown users as for wrong passwords', async () => {
    const user = await registerUser(app);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: user.username, password: 'nope' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody-here', password: 'nope' },
    });

    assert.equal(wrongPassword.statusCode, unknownUser.statusCode);
    assert.deepEqual(wrongPassword.json(), unknownUser.json());
  });
});

describe('GET /api/auth/salt/:username', () => {
  test('returns the real salt for an existing user', async () => {
    const user = await registerUser(app);
    const res = await app.inject({ method: 'GET', url: `/api/auth/salt/${user.username}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().salt, user.material.salt);
  });

  test('returns a salt for unknown users so accounts cannot be enumerated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/salt/definitely-not-a-user' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().salt, 'still returns a salt');
  });

  test('the dummy salt is stable across calls', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/auth/salt/ghost' });
    const second = await app.inject({ method: 'GET', url: '/api/auth/salt/ghost' });
    assert.equal(first.json().salt, second.json().salt);
  });

  test('different unknown usernames get different salts', async () => {
    const a = await app.inject({ method: 'GET', url: '/api/auth/salt/ghost-a' });
    const b = await app.inject({ method: 'GET', url: '/api/auth/salt/ghost-b' });
    assert.notEqual(a.json().salt, b.json().salt);
  });
});

describe('session lifecycle', () => {
  test('GET /api/auth/me requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
  });

  test('GET /api/auth/me returns the caller identity', async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: user.cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().username, user.username);
    assert.equal(res.json().id, user.id);
  });

  test('logout invalidates the session server-side', async () => {
    const user = await registerUser(app);

    const before = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: user.cookie },
    });
    assert.equal(before.statusCode, 200);

    await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie: user.cookie },
    });

    // The JWT itself is still cryptographically valid and unexpired; this
    // asserts the server-side session record is what actually gates access.
    const after = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: user.cookie },
    });
    assert.equal(after.statusCode, 401, 'the old cookie must stop working');
  });

  test('a forged cookie is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${config.cookieName}=not.a.jwt` },
    });
    assert.equal(res.statusCode, 401);
  });

  test('a token signed with the wrong secret is rejected', async () => {
    const { default: jwt } = await import('jsonwebtoken').catch(() => ({ default: null }));
    if (!jwt) return; // optional dep; skip rather than fail the suite
    const forged = jwt.sign({ id: 'x', username: 'x', jti: 'x' }, 'the-wrong-secret');
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${config.cookieName}=${forged}` },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('QR device sync relay', () => {
  test('round-trips a payload and issues a session to the new device', async () => {
    const user = await registerUser(app);
    const syncId = '11111111-2222-4333-8444-555555555555';

    const initiate = await app.inject({
      method: 'POST',
      url: '/api/auth/sync/initiate',
      headers: { cookie: user.cookie },
      payload: { syncId, payload: 'encrypted-identity-blob' },
    });
    assert.equal(initiate.statusCode, 200);

    const retrieve = await app.inject({
      method: 'GET',
      url: `/api/auth/sync/retrieve/${syncId}`,
    });
    assert.equal(retrieve.statusCode, 200);
    assert.equal(retrieve.json().payload, 'encrypted-identity-blob');
    assert.equal(retrieve.json().username, user.username);
    assert.ok(sessionCookie(retrieve), 'the new device gets a real session');
  });

  test('a sync payload can only be retrieved once', async () => {
    const user = await registerUser(app);
    const syncId = '11111111-2222-4333-8444-666666666666';

    await app.inject({
      method: 'POST',
      url: '/api/auth/sync/initiate',
      headers: { cookie: user.cookie },
      payload: { syncId, payload: 'blob' },
    });

    const first = await app.inject({ method: 'GET', url: `/api/auth/sync/retrieve/${syncId}` });
    const second = await app.inject({ method: 'GET', url: `/api/auth/sync/retrieve/${syncId}` });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 404, 'replay must fail');
  });

  test('initiating a sync requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sync/initiate',
      payload: { syncId: '11111111-2222-4333-8444-777777777777', payload: 'blob' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('rejects a non-uuid syncId', async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sync/initiate',
      headers: { cookie: user.cookie },
      payload: { syncId: '../../etc/passwd', payload: 'blob' },
    });
    assert.equal(res.statusCode, 400);
  });
});

// ============================================================
// Username enumeration
// ============================================================
// /auth/salt has to answer for accounts that do not exist, or the response
// itself reveals which usernames are taken. The stand-in it returns was keyed
// with a literal string committed to a public repository, so anyone could
// compute it and compare — the defence existed but did not work.

describe('the salt endpoint does not reveal who exists', () => {
  test('an unknown username still gets a well-formed salt', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/auth/salt/definitelynotarealaccount',
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().salt, /^.{24}$/);
  });

  test('a real and a fake username are indistinguishable in shape', async () => {
    const real = await registerUser(app);

    const known = (await app.inject({
      method: 'GET', url: `/api/auth/salt/${real.username}`,
    })).json().salt;
    const unknown = (await app.inject({
      method: 'GET', url: '/api/auth/salt/nosuchpersonhere',
    })).json().salt;

    assert.equal(known.length, unknown.length);
    assert.notEqual(known, unknown);
  });

  test('the stand-in is not derivable from a value in the source', async () => {
    // The old key was the literal 'dummy_salt_key'. If that ever reproduces
    // the response again, enumeration is back.
    const crypto = await import('node:crypto');
    const username = 'someoneunknown';

    const guessable = crypto.createHmac('sha256', 'dummy_salt_key')
      .update(username).digest('base64').substring(0, 24);

    const actual = (await app.inject({
      method: 'GET', url: `/api/auth/salt/${username}`,
    })).json().salt;

    assert.notEqual(actual, guessable);
  });
});

