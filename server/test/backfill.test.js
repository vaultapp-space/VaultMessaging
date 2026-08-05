import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

import pg from 'pg';

import { pgConfig, pgConnectionString } from '../src/db/config.js';

// ============================================================
// Phase 1 backfill
// ============================================================
// The plan calls this out as the step that must be exact. Messages are
// shallow by construction — retention is capped at 24h — but `chats` and
// `chat_members` are durable, and getting them wrong loses conversations and
// group membership, which users notice far more than losing yesterday's text.
//
// This test stages the migration deliberately: apply the baseline, seed data
// in the *old* shape, then run the chat-model and backfill migrations over
// it. That is the only way to exercise the path a real deployment takes.

const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.BACKFILL_TEST_DATABASE || 'vault_backfill_test';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB   = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const GROUP = '99999999-9999-4999-8999-999999999999';

let client;

// How many migrations sit at or above the backfill. Reverting the backfill
// means unwinding everything stacked on top of it, and hardcoding "1" breaks
// the moment another migration lands — as 0004 immediately did.
function migrationsFromBackfill() {
  return fs.readdirSync(path.join(serverRoot, 'migrations'))
    .filter((f) => f.endsWith('.js') && f >= '0003')
    .length;
}

function migrate(args) {
  execFileSync(process.execPath, [path.join(serverRoot, 'scripts', 'migrate.js'), ...args], {
    cwd: serverRoot,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: pgConnectionString({ database: DB }) },
  });
}

before(async () => {
  const admin = new pg.Client({
    ...pgConfig,
    database: 'postgres',
    user: process.env.TEST_PGUSER || undefined,
    password: process.env.TEST_PGPASSWORD || undefined,
  });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]
  );
  await admin.query(`DROP DATABASE IF EXISTS "${DB}"`);
  await admin.query(`CREATE DATABASE "${DB}" OWNER "${pgConfig.user}"`);
  await admin.end();

  // Only the baseline: this is the schema a deployed instance is running.
  migrate(['up', '1']);

  client = new pg.Client({ ...pgConfig, database: DB });
  await client.connect();

  await client.query(`
    INSERT INTO users (id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt) VALUES
      ($1,'alice','h','ik','spk','sig','s'),
      ($2,'bob','h','ik','spk','sig','s'),
      ($3,'carol','h','ik','spk','sig','s')`, [ALICE, BOB, CAROL]);

  await client.query(
    // No join_key: 0016 dropped it, so legacy seed data cannot carry one
    // either. The backfill in 0003 still references the column because it
    // runs before 0016 on a fresh migrate-up.
    `INSERT INTO groups (id, name, created_by) VALUES ($1,'Team',$2)`,
    [GROUP, ALICE]
  );
  await client.query(
    `INSERT INTO group_members (group_id, user_id) VALUES ($1,$2),($1,$3),($1,$4)`,
    [GROUP, ALICE, BOB, CAROL]
  );

  // Traffic in both directions between the same pair — this must collapse to
  // a single private chat, not one per direction.
  await client.query(`
    INSERT INTO encrypted_messages
      (sender_id, recipient_id, ciphertext, message_number, expires_at, sent_at, read) VALUES
      ($1,$2,'c1',0, now()+interval '1h', now()-interval '10 min', true),
      ($2,$1,'c2',0, now()+interval '1h', now()-interval '9 min',  false),
      ($1,$2,'c3',1, now()+interval '1h', now()-interval '8 min',  false)`, [ALICE, BOB]);

  // Both group_id spellings the client has produced: bare uuid and the
  // 'group-<uuid>' form assembled in the UI.
  await client.query(`
    INSERT INTO encrypted_messages
      (sender_id, recipient_id, ciphertext, message_number, expires_at, sent_at, group_id) VALUES
      ($1,$2,'g1',0, now()+interval '1h', now()-interval '5 min', $4),
      ($1,$3,'g1',0, now()+interval '1h', now()-interval '5 min', $5)`,
    [ALICE, BOB, CAROL, `group-${GROUP}`, GROUP]);

  // Now apply the chat model and the backfill.
  migrate(['up']);
});

after(async () => {
  if (client) await client.end();
});

const scalar = async (sql, params = []) => (await client.query(sql, params)).rows[0];

describe('chats', () => {
  test('creates exactly one chat per group and per conversing pair', async () => {
    const row = await scalar(`
      SELECT count(*) FILTER (WHERE type='group')   AS groups,
             count(*) FILTER (WHERE type='private') AS privates,
             count(*)                               AS total
        FROM chats`);
    assert.equal(Number(row.groups), 1);
    assert.equal(Number(row.privates), 1, 'both directions collapse to one chat');
    assert.equal(Number(row.total), 2);
  });

  test('everything migrated is a secret chat', async () => {
    // All existing data is end-to-end encrypted and must keep being treated
    // that way; only chats created after this migration default to cloud.
    const row = await scalar(`SELECT count(*) AS n FROM chats WHERE mode <> 'secret'`);
    assert.equal(Number(row.n), 0);
  });

  test('a group chat keeps the original group id', async () => {
    // The client addresses groups as `group-<uuid>`; changing the id would
    // make every client lose its groups at once.
    // join_key was asserted here until 0016 dropped it — the backfill used to
    // carry the old bearer secret across. It no longer exists to carry.
    const row = await scalar(`SELECT title, created_by FROM chats WHERE id = $1`, [GROUP]);
    assert.ok(row, 'chat exists under the original group id');
    assert.equal(row.title, 'Team');
    assert.equal(row.created_by, ALICE);
  });

  test('the group creator is recorded as owner', async () => {
    const row = await scalar(
      `SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2`, [GROUP, ALICE]);
    assert.equal(row.role, 'owner');
  });

  test('membership row counts match the source tables', async () => {
    // 3 group members + 2 private participants.
    const row = await scalar(`SELECT count(*) AS n FROM chat_members`);
    assert.equal(Number(row.n), 5);

    const groupMembers = await scalar(
      `SELECT count(*) AS n FROM chat_members WHERE chat_id = $1`, [GROUP]);
    const sourceMembers = await scalar(
      `SELECT count(*) AS n FROM group_members WHERE group_id = $1`, [GROUP]);
    assert.equal(groupMembers.n, sourceMembers.n, 'no member lost or invented');
  });

  test('members_count is consistent with chat_members', async () => {
    const row = await scalar(`
      SELECT count(*) AS mismatched FROM chats c
       WHERE c.members_count <> (SELECT count(*) FROM chat_members m WHERE m.chat_id = c.id)`);
    assert.equal(Number(row.mismatched), 0);
  });

  test('the private chat id is deterministic from the pair', async () => {
    // Both participants must derive the same id independently, in either
    // argument order, with no lookup table.
    const row = await scalar(`
      SELECT (SELECT id FROM chats WHERE type='private') AS actual,
             uuid_generate_v5('b7f4a3c2-8e1d-4f6a-9b2c-5d3e7a1f8c04'::uuid,
                              LEAST($1::uuid,$2::uuid)::text || GREATEST($1::uuid,$2::uuid)::text) AS expected,
             uuid_generate_v5('b7f4a3c2-8e1d-4f6a-9b2c-5d3e7a1f8c04'::uuid,
                              LEAST($2::uuid,$1::uuid)::text || GREATEST($2::uuid,$1::uuid)::text) AS reversed`,
      [ALICE, BOB]);
    assert.equal(row.actual, row.expected);
    assert.equal(row.actual, row.reversed, 'argument order must not matter');
  });
});

describe('messages', () => {
  test('every message resolves to exactly one chat', async () => {
    const row = await scalar(`SELECT count(*) AS orphans FROM messages WHERE chat_id IS NULL`);
    assert.equal(Number(row.orphans), 0);
  });

  test('both group_id spellings resolve to the same chat', async () => {
    // 'group-<uuid>' and the bare uuid were both written by the client.
    const row = await scalar(
      `SELECT count(*) AS n, count(DISTINCT chat_id) AS chats
         FROM messages WHERE group_id IS NOT NULL`);
    assert.equal(Number(row.n), 2);
    assert.equal(Number(row.chats), 1, 'prefixed and bare ids must not split the chat');
  });

  test('seq is unique within a chat', async () => {
    const row = await scalar(`
      SELECT count(*) AS dupes FROM (
        SELECT chat_id, seq FROM messages
         WHERE chat_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) d`);
    assert.equal(Number(row.dupes), 0);
  });

  test('seq is a gapless 1..n run ordered by send time', async () => {
    const { rows } = await client.query(`
      SELECT m.seq, m.ciphertext FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE c.type = 'private' ORDER BY m.seq`);
    assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.ciphertext), ['c1', 'c2', 'c3'], 'ordered by sent_at');
  });

  test('expires_at survives the migration on every row', async () => {
    // The 24h rule: no message may come out of this migration immortal.
    const row = await scalar(`SELECT count(*) AS immortal FROM messages WHERE expires_at IS NULL`);
    assert.equal(Number(row.immortal), 0);
  });

  test('body stays null — nothing was silently converted to plaintext', async () => {
    const row = await scalar(`SELECT count(*) AS n FROM messages WHERE body IS NOT NULL`);
    assert.equal(Number(row.n), 0);
  });
});

describe('chat counters and read state', () => {
  test('last_seq matches the highest message seq', async () => {
    const row = await scalar(`
      SELECT count(*) AS mismatched FROM chats c
       WHERE c.last_seq <> COALESCE((SELECT max(seq) FROM messages m WHERE m.chat_id = c.id), 0)`);
    assert.equal(Number(row.mismatched), 0);
  });

  test('last_message_at is populated for chats with messages', async () => {
    const row = await scalar(`
      SELECT count(*) AS missing FROM chats c
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
         AND c.last_message_at IS NULL`);
    assert.equal(Number(row.missing), 0);
  });

  test('unread counts carry over from the per-message read flag', async () => {
    // Alice has one unread (bob's c2); Bob has one unread (alice's c3) and
    // has read up to seq 1.
    const { rows } = await client.query(`
      SELECT u.username, r.unread_count, r.read_inbox_max_seq
        FROM chat_read_state r
        JOIN users u ON u.id = r.user_id
        JOIN chats c ON c.id = r.chat_id
       WHERE c.type = 'private' ORDER BY u.username`);

    const byUser = Object.fromEntries(rows.map((r) => [r.username, r]));
    assert.equal(Number(byUser.alice.unread_count), 1);
    assert.equal(Number(byUser.bob.unread_count), 1);
    assert.equal(Number(byUser.bob.read_inbox_max_seq), 1, 'bob had read c1');
  });

  test('read state exists for every member of every chat', async () => {
    const row = await scalar(`
      SELECT count(*) AS missing
        FROM chat_members cm
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = cm.chat_id)
         AND NOT EXISTS (SELECT 1 FROM chat_read_state r
                          WHERE r.chat_id = cm.chat_id AND r.user_id = cm.user_id)`);
    assert.equal(Number(row.missing), 0);
  });
});

describe('reversibility', () => {
  test('down detaches chats and up rebuilds them identically', async () => {
    const before = await scalar(`
      SELECT (SELECT count(*) FROM chats) AS chats,
             (SELECT count(*) FROM messages WHERE chat_id IS NOT NULL) AS attached`);

    migrate(['down', String(migrationsFromBackfill())]);
    const reverted = await scalar(`
      SELECT (SELECT count(*) FROM chats) AS chats,
             (SELECT count(*) FROM messages WHERE chat_id IS NOT NULL) AS attached`);
    assert.equal(Number(reverted.chats), 0);
    assert.equal(Number(reverted.attached), 0);

    migrate(['up']);
    const after = await scalar(`
      SELECT (SELECT count(*) FROM chats) AS chats,
             (SELECT count(*) FROM messages WHERE chat_id IS NOT NULL) AS attached`);

    assert.equal(after.chats, before.chats, 're-running the backfill is idempotent');
    assert.equal(after.attached, before.attached);
  });

  test('the source tables are never modified by the backfill', async () => {
    // groups/group_members are the record of truth being migrated *from*;
    // a backfill that mutates its own source cannot be safely re-run.
    const row = await scalar(`
      SELECT (SELECT count(*) FROM groups) AS groups,
             (SELECT count(*) FROM group_members) AS members`);
    assert.equal(Number(row.groups), 1);
    assert.equal(Number(row.members), 3);
  });
});
