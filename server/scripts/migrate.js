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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pgConnectionString } from '../src/db/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, '..');
const bin = path.join(serverRoot, 'node_modules', '.bin', 'node-pg-migrate');

// Checked explicitly, because the failure is otherwise completely silent:
// spawnSync on a missing binary returns status null, `process.exit(null ?? 1)`
// exits 1, and nothing is ever printed. A deploy hit exactly that — the box
// had been installed with `npm ci --omit=dev`, which removes node-pg-migrate
// (a devDependency), so migrations "failed" with no output at all and the
// server was left running old code.
if (!existsSync(bin)) {
  console.error(`Cannot find node-pg-migrate at ${bin}`);
  console.error('It is a devDependency — an install with --omit=dev removes it.');
  console.error('Run `npm ci` (without --omit=dev) in server/ and try again.');
  process.exit(1);
}

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

if (result.error) {
  console.error(`Could not run node-pg-migrate: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
