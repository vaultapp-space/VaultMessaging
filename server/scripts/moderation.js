#!/usr/bin/env node
// ============================================================
// Vault — moderation CLI
// ============================================================
// The takedown path, offline. Everything here is also reachable over HTTP
// (routes/moderation.routes.js) for an operator account, but this exists as
// the primitive rather than the fallback: it adds no attack surface at all —
// there is no privileged endpoint to find, fuzz, or forget to gate — and it
// keeps working if the HTTP surface is ever removed.
//
// Usage (from server/):
//
//   node scripts/moderation.js queue
//   node scripts/moderation.js show <postId>
//   node scripts/moderation.js remove <postId> --category=csam --reason="..."
//   node scripts/moderation.js block-author <userId> --days=30 --reason="..."
//   node scripts/moderation.js unblock-author <userId>
//   node scripts/moderation.js grant-operator <userId>
//
// Actions are attributed to the OPERATOR_USER_ID environment variable when it
// is set, and left null otherwise — moderation_actions.operator_id is nullable
// precisely so an offline action is still recorded rather than refused.

import pg from 'pg';

import { pgConfig } from '../src/db/config.js';
import { createPosts } from '../src/repos/posts.repo.js';

const UPLOADS_DIR = new URL('../uploads', import.meta.url).pathname;

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

function usage() {
  console.error(`Usage:
  queue                                    list reported posts, most recent first
  show <postId>                            one post with its reports
  remove <postId> [--category=] [--reason=]  take a post down
  block-author <userId> --days=N [--reason=]  bar an account from posting
  unblock-author <userId>                  lift a posting block
  grant-operator <userId>                  grant the HTTP moderation surface`);
  process.exit(1);
}

const [command, target, ...rest] = process.argv.slice(2);
if (!command) usage();

const flags = parseFlags(rest);
const pool = new pg.Pool(pgConfig);
const posts = createPosts({ pool, uploadsDir: UPLOADS_DIR });
const operatorId = process.env.OPERATOR_USER_ID || null;

try {
  switch (command) {
    case 'queue': {
      const reports = await posts.reportQueue({ limit: Number(flags.limit) || 50 });
      if (reports.length === 0) {
        console.log('Queue empty.');
        break;
      }
      for (const r of reports) {
        // Reports expire with their post, so the operator needs to know how
        // long is left before the question answers itself.
        const hoursLeft = Math.max(0, (new Date(r.expiresAt) - Date.now()) / 3600000);
        console.log(
          `${r.postId}  @${r.username}  ${r.reportCount} report(s) ` +
          `[${r.categories.join(', ')}]  ${hoursLeft.toFixed(1)}h left`
        );
        if (r.body) console.log(`    ${r.body.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (r.media) console.log(`    media: ${r.media.fileId} (${r.media.mimeType})`);
      }
      break;
    }

    case 'show': {
      if (!target) usage();
      const { rows } = await pool.query(
        `SELECT p.*, u.username FROM posts p JOIN users u ON u.id = p.author_id
          WHERE p.id = $1`, [target]
      );
      if (!rows[0]) { console.error('No such post.'); process.exitCode = 1; break; }
      console.log(JSON.stringify(rows[0], null, 2));
      const { rows: reports } = await pool.query(
        'SELECT category, note, created_at FROM post_reports WHERE post_id = $1 ORDER BY created_at',
        [target]
      );
      console.log(`\n${reports.length} report(s):`);
      for (const r of reports) console.log(`  ${r.category}${r.note ? ` — ${r.note}` : ''}`);
      break;
    }

    case 'remove': {
      if (!target) usage();
      const removed = await posts.removePost(target, operatorId, {
        category: flags.category ?? null,
        reason: flags.reason ?? null,
      });
      if (!removed) { console.error('No such post, or already removed.'); process.exitCode = 1; break; }
      console.log(`Removed ${target} (author ${removed.authorId}). Media unlinked.`);
      break;
    }

    case 'block-author': {
      if (!target || flags.days === undefined) usage();
      const ok = await posts.setPostingBlock(target, operatorId, {
        days: Number(flags.days),
        reason: flags.reason ?? null,
      });
      console.log(ok ? `Blocked ${target} for ${flags.days} day(s).` : 'No such user.');
      if (!ok) process.exitCode = 1;
      break;
    }

    case 'unblock-author': {
      if (!target) usage();
      const ok = await posts.setPostingBlock(target, operatorId, { days: 0 });
      console.log(ok ? `Unblocked ${target}.` : 'No such user.');
      if (!ok) process.exitCode = 1;
      break;
    }

    case 'grant-operator': {
      if (!target) usage();
      const { rowCount } = await pool.query(
        'UPDATE users SET is_operator = true WHERE id = $1', [target]
      );
      console.log(rowCount ? `Granted operator to ${target}.` : 'No such user.');
      if (!rowCount) process.exitCode = 1;
      break;
    }

    default:
      usage();
  }
} finally {
  await pool.end();
}
