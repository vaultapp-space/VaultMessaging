#!/usr/bin/env node
// ============================================================
// Vault — Migration CLI wrapper
// ============================================================
// Thin shim around node-pg-migrate that derives DATABASE_URL from the same
// PG* environment variables the server uses (see src/db/config.js), so
// `npm run migrate:up` can never target a different database than the app.
// Any DATABASE_URL already set in the environment wins, which is how CI
// points migrations at a throwaway database.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pgConnectionString } from '../src/db/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, '..');
const bin = path.join(serverRoot, 'node_modules', '.bin', 'node-pg-migrate');

const result = spawnSync(
  bin,
  ['--migrations-dir', path.join(serverRoot, 'migrations'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || pgConnectionString(),
    },
  }
);

process.exit(result.status ?? 1);
