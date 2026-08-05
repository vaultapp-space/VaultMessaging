import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

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

async function createGroup(creator, members, name = 'test group') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: { cookie: creator.cookie },
    payload: { name, members: members.map((m) => m.id) },
  });
  assert.equal(res.statusCode, 201, `group create failed: ${res.body}`);
  return res.json();
}

describe('POST /api/groups', () => {
  test('creates a group containing the creator and members', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const group = await createGroup(alice, [bob]);

    assert.ok(group.id);
    assert.equal(group.name, 'test group');
    const memberIds = group.members.map((m) => m.id).sort();
    assert.deepEqual(memberIds, [alice.id, bob.id].sort());
  });

  test('includes the creator even if they are not in the members list', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const group = await createGroup(alice, [bob]);
    assert.ok(group.members.some((m) => m.id === alice.id));
  });

  test('does not duplicate the creator when they are listed explicitly', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie: alice.cookie },
      payload: { name: 'dedup', members: [alice.id, bob.id, alice.id] },
    });

    const ids = res.json().members.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'members must be unique');
    assert.equal(ids.length, 2);
  });

  test('requires authentication', async () => {
    const bob = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'x', members: [bob.id] },
    });
    assert.equal(res.statusCode, 401);
  });

  test('rejects an empty member list', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie: alice.cookie },
      payload: { name: 'x', members: [] },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('GET /api/groups', () => {
  test('lists only the groups the caller belongs to', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);

    const group = await createGroup(alice, [bob], 'alice+bob');

    const mine = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: alice.cookie },
    });
    assert.ok(mine.json().some((g) => g.id === group.id));

    const theirs = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: mallory.cookie },
    });
    assert.ok(
      !theirs.json().some((g) => g.id === group.id),
      'a non-member must not see the group'
    );
  });
});

describe('GET /api/groups — member aggregation', () => {
  test('each group carries exactly its own members', async () => {
    // Guards the single-query rewrite of getGroupsForUser: a bad join would
    // cross-contaminate member lists between a user's groups.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    const first = await createGroup(alice, [bob], 'first');
    const second = await createGroup(alice, [carol], 'second');

    const res = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);

    const groups = res.json();
    const byId = new Map(groups.map((g) => [g.id, g]));

    const firstMembers = byId.get(first.id).members.map((m) => m.id).sort();
    const secondMembers = byId.get(second.id).members.map((m) => m.id).sort();

    assert.deepEqual(firstMembers, [alice.id, bob.id].sort());
    assert.deepEqual(secondMembers, [alice.id, carol.id].sort());
  });

  test('reports the creator for each group', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: alice.cookie },
    });
    const found = res.json().find((g) => g.id === group.id);

    assert.equal(found.createdBy, alice.id);
    assert.equal(found.name, 'test group');
    assert.equal(found.joinKey, undefined,
      'the group must not expose a bearer join secret');
  });

  test('a member sees the group with the full member list', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob], 'shared');

    const res = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: bob.cookie },
    });
    const found = res.json().find((g) => g.id === group.id);

    assert.ok(found, 'bob sees the group he was added to');
    assert.deepEqual(found.members.map((m) => m.id).sort(), [alice.id, bob.id].sort());
  });
});

// ============================================================
// The removed join-key path
// ============================================================
// `POST /api/groups/join` took a permanent, unrevocable bearer secret: anyone
// who had ever seen a group's join key could rejoin forever, including members
// who had been removed or banned. Invite links (0008) replaced it and 0016
// dropped the column.
//
// These tests exist so the route cannot come back by accident. Reintroducing
// a bearer-secret join path would silently undo the invite system's entire
// reason for existing.

describe('the legacy join-key path is gone', () => {
  test('the route no longer exists', async () => {
    const carol = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/join',
      headers: { cookie: carol.cookie },
      payload: { joinKey: 'anything-at-all' },
    });
    assert.equal(res.statusCode, 404, 'POST /api/groups/join must not be routable');
  });

  test('the column is gone from both tables', async () => {
    const { rows } = await harness.store.pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'join_key' AND table_name IN ('chats', 'groups')`
    );
    assert.deepEqual(rows, [], 'join_key must not exist anywhere');
  });

  test('creating a group mints no join secret', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    assert.equal(group.joinKey, undefined);
    assert.equal(group.join_key, undefined);
  });
});

describe('POST /api/groups/:id/leave', () => {
  test('removes the caller from the group', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/leave`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 200);

    const list = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: bob.cookie },
    });
    assert.ok(!list.json().some((g) => g.id === group.id));
  });

  test('403s when the caller is not a member', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/leave`,
      headers: { cookie: mallory.cookie },
    });
    assert.equal(res.statusCode, 403);
  });

  test('404s for an unknown group', async () => {
    const alice = await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${randomUUID()}/leave`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a departed member can no longer send to the group', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    await app.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/leave`,
      headers: { cookie: bob.cookie },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie: bob.cookie },
      payload: {
        recipientId: alice.id,
        ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0,
        groupId: group.id,
      },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('DELETE /api/groups/:id/members/:userId', () => {
  test('lets the creator remove a member', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/members/${bob.id}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);

    const list = await app.inject({
      method: 'GET', url: '/api/groups', headers: { cookie: bob.cookie },
    });
    assert.ok(!list.json().some((g) => g.id === group.id));
  });

  test('403s when a non-creator member tries to remove someone', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const group = await createGroup(alice, [bob, carol]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/members/${carol.id}`,
      headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 403, 'only the creator may remove members');
  });

  test('403s for a complete outsider', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const mallory = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/members/${bob.id}`,
      headers: { cookie: mallory.cookie },
    });
    assert.equal(res.statusCode, 403);
  });

  test('400s when the creator targets themselves', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/members/${alice.id}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 400);
  });

  test('404s when the target is not a member', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await createGroup(alice, [bob]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/groups/${group.id}/members/${outsider.id}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});
