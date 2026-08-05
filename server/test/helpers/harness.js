// ============================================================
// Vault — Server Test Harness
// ============================================================
// Builds a real app against a real Postgres and Redis. The store is
// deliberately NOT mocked: it is ~900 lines of SQL, and a mock would only
// test the mock. Isolation comes from a dedicated database and a dedicated
// Redis db index, both wiped between tests.

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { buildApp } from '../../src/app.js';
import { createStore } from '../../src/store.js';
import baseConfig from '../../src/config.js';
import { pgConfig, pgConnectionString } from '../../src/db/config.js';

const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TEST_DATABASE = process.env.TEST_PGDATABASE || 'vault_test';
// Kept away from db 0 so a stray test run can never flush a developer's
// working Redis state.
export const TEST_REDIS_DB = parseInt(process.env.TEST_REDIS_DB || '15', 10);

let prepared = false;

// Creates the test database if absent and brings it to the latest migration.
// Runs once per process; every test then reuses the migrated schema.
export async function prepareTestDatabase() {
  if (prepared) return;

  // Connect to the maintenance database to check for / create the test one.
  // CREATE DATABASE cannot run inside a transaction or via the pool.
  const admin = new pg.Client({
    ...pgConfig,
    database: 'postgres',
    // The app role usually lacks CREATEDB; fall back to the OS superuser,
    // which is how a stock local Postgres is set up.
    user: process.env.TEST_PGUSER || undefined,
    password: process.env.TEST_PGPASSWORD || undefined,
  });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DATABASE]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${TEST_DATABASE}" OWNER "${pgConfig.user}"`);
  }
  await admin.end();

  execFileSync(process.execPath, [path.join(serverRoot, 'scripts', 'migrate.js'), 'up'], {
    cwd: serverRoot,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: pgConnectionString({ database: TEST_DATABASE }) },
  });

  prepared = true;
}

// Route-level rate limits (register is 5/min) would make any test file that
// creates more than five users fail for the wrong reason. Giving every
// request its own bucket disables limiting without changing route configs —
// the limiter itself is exercised explicitly in its own test via a fixed key.
const testConfig = {
  ...baseConfig,
  rateLimit: {
    ...baseConfig.rateLimit,
    keyGenerator: () => randomUUID(),
  },
};

export { testConfig };

export async function createTestApp({ config: configOverrides = {}, serverOptions = {} } = {}) {
  await prepareTestDatabase();

  const store = createStore({
    pg: { database: TEST_DATABASE },
    redis: { db: TEST_REDIS_DB },
  });
  await store.schemaReady;

  await truncateAll(store);
  await store.redis.flushdb();

  const app = await buildApp({
    store,
    config: { ...testConfig, ...configOverrides },
    logger: false,
    // A rejected upgrade (e.g. CORS refusing a disallowed Origin) can leave a
    // lingering connection that app.close() would otherwise wait on forever,
    // hanging the whole test file.
    serverOptions: { forceCloseConnections: true, ...serverOptions },
  });
  await app.ready();

  return {
    app,
    store,
    async close() {
      // Mirrors the bounded shutdown in src/index.js. app.close() can stay
      // pending forever after a rejected WebSocket upgrade, which would hang
      // the whole test file rather than failing it.
      for (const client of app.websocketServer?.clients ?? []) {
        try { client.terminate(); } catch {}
      }
      try { app.server.closeAllConnections?.(); } catch {}

      await Promise.race([
        app.close(),
        new Promise((resolve) => setTimeout(resolve, 3000).unref?.()),
      ]);
      await store.close();
    },
  };
}

export async function truncateAll(store) {
  // users cascades to prekeys, messages, chat_members, chat_read_state,
  // push_subscriptions and file_allowed_users. groups, chats and files are
  // truncated explicitly because they can outlive their creator
  // (ON DELETE SET NULL).
  await store.pool.query(
    'TRUNCATE users, groups, chats, files, server_config RESTART IDENTITY CASCADE'
  );
}

// ─── Fixtures ───────────────────────────────────────────────

let userSeq = 0;

// Minimal but schema-valid key material. These are opaque base64 blobs to the
// server — it never inspects them — so tests do not need real ECDH keys.
export function fakeKeyMaterial() {
  return {
    identityKey: Buffer.from(`identity-${randomUUID()}`).toString('base64'),
    signedPrekey: Buffer.from(`signed-${randomUUID()}`).toString('base64'),
    prekeySig: Buffer.from(`sig-${randomUUID()}`).toString('base64'),
    oneTimePrekeys: Array.from({ length: 3 }, (_, i) =>
      Buffer.from(`otp-${i}-${randomUUID()}`).toString('base64')
    ),
    salt: Buffer.from(randomUUID().slice(0, 16)).toString('base64'),
  };
}

// Registers a user through the real HTTP route and returns the session cookie,
// so tests exercise the same path a browser would.
export async function registerUser(app, overrides = {}) {
  const username = overrides.username || `user${(userSeq += 1)}${Date.now().toString(36)}`;
  const password = overrides.password || 'correct horse battery staple';
  const material = fakeKeyMaterial();

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password, ...material, ...overrides },
  });

  if (res.statusCode !== 201) {
    throw new Error(`registerUser failed: ${res.statusCode} ${res.body}`);
  }

  return {
    ...res.json(),
    username,
    password,
    material,
    cookie: sessionCookie(res),
  };
}

export function sessionCookie(res) {
  const cookies = res.cookies || [];
  const match = cookies.find((c) => c.name === baseConfig.cookieName);
  return match ? `${match.name}=${match.value}` : null;
}

export function authHeaders(user) {
  return { cookie: user.cookie };
}
