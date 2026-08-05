#!/usr/bin/env node
// ============================================================
// Vault — E2E backend launcher
// ============================================================
// Boots the real server against a dedicated, freshly migrated database so an
// end-to-end run can never read or clobber development data. Used by
// playwright.config.js as a webServer command.

import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { pgConfig, pgConnectionString } from '../src/db/config.js';

const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DATABASE = process.env.E2E_PGDATABASE || 'vault_e2e';

// Recreate the database from scratch so each run starts from a known state.
const admin = new pg.Client({
  ...pgConfig,
  database: 'postgres',
  user: process.env.TEST_PGUSER || undefined,
  password: process.env.TEST_PGPASSWORD || undefined,
});
await admin.connect();
await admin.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [E2E_DATABASE]
);
await admin.query(`DROP DATABASE IF EXISTS "${E2E_DATABASE}"`);
await admin.query(`CREATE DATABASE "${E2E_DATABASE}" OWNER "${pgConfig.user}"`);
await admin.end();

const databaseUrl = pgConnectionString({ database: E2E_DATABASE });

const migrate = spawnSync(
  process.execPath,
  [path.join(serverRoot, 'scripts', 'migrate.js'), 'up'],
  { cwd: serverRoot, stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl } }
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const child = spawn(process.execPath, [path.join(serverRoot, 'src', 'index.js')], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PGDATABASE: E2E_DATABASE,
    // Several registrations per run from a single IP; see config.js.
    RATE_LIMIT_DISABLED: '1',
    // Keep E2E traffic off the developer's Redis working set.
    REDIS_DB: process.env.E2E_REDIS_DB || '14',
  },
});

const forward = (signal) => child.kill(signal);
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
