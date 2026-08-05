import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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

async function makeGroup(owner, members, name = 'the group') {
  const res = await app.inject({
    method: 'POST', url: '/api/groups',
    headers: { cookie: owner.cookie },
    payload: { name, members: members.map((m) => m.id) },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function createInvite(user, chatId, body = {}) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/invites`,
    headers: { cookie: user.cookie }, payload: body,
  });
}

function join(user, hash) {
  return app.inject({
    method: 'POST', url: `/api/invites/${hash}/join`, headers: { cookie: user.cookie },
  });
}

// ============================================================
// Invites — the reason this phase matters
// ============================================================
// These replace `chats.join_key`, a permanent unrevocable bearer secret:
// anyone who ever saw it could rejoin forever, with no expiry, no usage
// limit, no revocation, and no record of who used it.

describe('invite links', () => {
  test('an invite lets a stranger join', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const invite = (await createInvite(owner, group.id)).json();
    const res = await join(outsider, invite.hash);

    assert.equal(res.statusCode, 200);
    assert.ok(await harness.store.chats.isMember(group.id, outsider.id));
  });

  test('a revoked invite stops working', async () => {
    // The whole point: access can be withdrawn after the fact.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const invite = (await createInvite(owner, group.id)).json();
    await app.inject({
      method: 'DELETE', url: `/api/chats/${group.id}/invites/${invite.hash}`,
      headers: { cookie: owner.cookie },
    });

    const res = await join(outsider, invite.hash);
    assert.equal(res.statusCode, 403);
    assert.equal(await harness.store.chats.isMember(group.id, outsider.id), false);
  });

  test('an expired invite stops working', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const invite = (await createInvite(owner, group.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })).json();

    assert.equal((await join(outsider, invite.hash)).statusCode, 403);
  });

  test('a usage limit is enforced', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const first = await registerUser(app);
    const second = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const invite = (await createInvite(owner, group.id, { usageLimit: 1 })).json();

    assert.equal((await join(first, invite.hash)).statusCode, 200);
    assert.equal((await join(second, invite.hash)).statusCode, 403, 'the limit holds');
  });

  test('concurrent redemptions cannot exceed the limit', async () => {
    // The check and the increment are one statement precisely so two people
    // racing on the last slot cannot both get in.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const invite = (await createInvite(owner, group.id, { usageLimit: 2 })).json();

    const contenders = await Promise.all(
      Array.from({ length: 5 }, () => registerUser(app))
    );
    const results = await Promise.all(contenders.map((u) => join(u, invite.hash)));
    const admitted = results.filter((r) => r.statusCode === 200).length;

    assert.equal(admitted, 2, `expected exactly 2 admitted, got ${admitted}`);
  });

  test('usage is attributed, so an admin can see who joined', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const invite = (await createInvite(owner, group.id)).json();
    await join(outsider, invite.hash);

    const { rows } = await harness.store.pool.query(
      `SELECT user_id FROM chat_invite_uses WHERE hash = $1`, [invite.hash]
    );
    assert.deepEqual(rows.map((r) => r.user_id), [outsider.id]);
  });

  test('an ordinary member cannot create invites in a group they do not manage', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const res = await createInvite(member, group.id);
    assert.equal(res.statusCode, 403);
  });

  test('a non-member gets 404, not 403', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    assert.equal((await createInvite(outsider, group.id)).statusCode, 404);
  });

  test('an unknown invite is refused', async () => {
    const user = await registerUser(app);
    assert.equal((await join(user, 'not-a-real-invite')).statusCode, 403);
  });
});

describe('bans', () => {
  test('a banned user is removed and cannot rejoin with a valid invite', async () => {
    // Removal alone achieves nothing if any link they still hold lets them
    // straight back in.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const invite = (await createInvite(owner, group.id)).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/members/${member.id}/ban`,
      headers: { cookie: owner.cookie }, payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(await harness.store.chats.isMember(group.id, member.id), false);

    assert.equal((await join(member, invite.hash)).statusCode, 403, 'the ban outlives the invite');
  });

  test('unbanning restores the ability to join', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const invite = (await createInvite(owner, group.id)).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/members/${member.id}/ban`,
      headers: { cookie: owner.cookie }, payload: {},
    });
    await app.inject({
      method: 'DELETE', url: `/api/chats/${group.id}/members/${member.id}/ban`,
      headers: { cookie: owner.cookie },
    });

    assert.equal((await join(member, invite.hash)).statusCode, 200);
  });

  test('a member cannot ban anyone', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const other = await registerUser(app);
    const group = await makeGroup(owner, [member, other]);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/members/${other.id}/ban`,
      headers: { cookie: member.cookie }, payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  test('an admin cannot ban the owner', async () => {
    // Otherwise promoting someone hands them the ability to take the group.
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const group = await makeGroup(owner, [admin]);

    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/members/${admin.id}/role`,
      headers: { cookie: owner.cookie }, payload: { role: 'admin' },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/members/${owner.id}/ban`,
      headers: { cookie: admin.cookie }, payload: {},
    });
    assert.equal(res.statusCode, 403);
    assert.ok(await harness.store.chats.isMember(group.id, owner.id));
  });

  test('you cannot ban yourself', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/members/${owner.id}/ban`,
      headers: { cookie: owner.cookie }, payload: {},
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('roles and rights', () => {
  test('the creator has owner rights', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const res = await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/rights`, headers: { cookie: owner.cookie },
    });
    assert.ok(res.json().rights.includes('promote'));
    assert.ok(res.json().rights.includes('ban'));
  });

  test('a member has posting rights but no moderation rights', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const rights = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/rights`, headers: { cookie: member.cookie },
    })).json().rights;

    assert.ok(rights.includes('post'));
    assert.ok(!rights.includes('ban'));
    assert.ok(!rights.includes('promote'));
  });

  test('promotion grants moderation rights', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/members/${member.id}/role`,
      headers: { cookie: owner.cookie }, payload: { role: 'admin' },
    });

    const rights = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/rights`, headers: { cookie: member.cookie },
    })).json().rights;
    assert.ok(rights.includes('ban'));
  });

  test('a member cannot promote themselves', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/members/${member.id}/role`,
      headers: { cookie: member.cookie }, payload: { role: 'admin' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a private chat has no hierarchy', async () => {
    // Treating one participant as owner would let them moderate the other.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id },
    })).json();

    const rights = (await app.inject({
      method: 'GET', url: `/api/chats/${chat.id}/rights`, headers: { cookie: alice.cookie },
    })).json().rights;

    assert.ok(!rights.includes('ban'));
    assert.ok(!rights.includes('promote'));
  });
});

describe('polls', () => {
  async function makePoll(user, chatId, body = {}) {
    return app.inject({
      method: 'POST', url: `/api/chats/${chatId}/polls`,
      headers: { cookie: user.cookie },
      payload: { question: 'Lunch?', options: ['Pizza', 'Salad'], ...body },
    });
  }

  test('creates a poll and returns its options', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);

    const res = await makePoll(owner, group.id);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().poll.options.length, 2);
    assert.equal(res.json().poll.totalVoters, 0);
  });

  test('records a vote and counts it once', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id)).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: member.cookie }, payload: { optionIds: [0] },
    });

    assert.equal(res.statusCode, 200);
    const poll = res.json().poll;
    assert.equal(poll.options[0].votes, 1);
    assert.equal(poll.options[0].chosenByMe, true);
    assert.equal(poll.totalVoters, 1);
  });

  test('changing a vote replaces it rather than adding one', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id)).json();

    const vote = (ids) => app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: member.cookie }, payload: { optionIds: ids },
    });

    await vote([0]);
    const res = await vote([1]);
    const poll = res.json().poll;

    assert.equal(poll.options[0].votes, 0, 'the old vote is gone');
    assert.equal(poll.options[1].votes, 1);
    assert.equal(poll.totalVoters, 1, 'still one voter, not two');
  });

  test('a single-choice poll ignores extra options', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id)).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: member.cookie }, payload: { optionIds: [0, 1] },
    });

    const poll = res.json().poll;
    assert.equal(poll.options[0].votes + poll.options[1].votes, 1);
  });

  test('a multi-choice poll accepts several', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id, { allowsMultiple: true })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: member.cookie }, payload: { optionIds: [0, 1] },
    });

    const poll = res.json().poll;
    assert.equal(poll.options[0].votes, 1);
    assert.equal(poll.options[1].votes, 1);
    assert.equal(poll.totalVoters, 1, 'one person, two choices');
  });

  test('rejects an out-of-range option', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id)).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: member.cookie }, payload: { optionIds: [99] },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a non-member cannot vote', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const outsider = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    const { seq } = (await makePoll(owner, group.id)).json();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages/${seq}/vote`,
      headers: { cookie: outsider.cookie }, payload: { optionIds: [0] },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a secret chat refuses server-side polls', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const secret = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'secret' },
    })).json();

    const res = await makePoll(alice, secret.id);
    assert.equal(res.statusCode, 400);
  });

  test('a poll dies with its message', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    await makePoll(owner, group.id);

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second' WHERE chat_id = $1`, [group.id]
    );
    await harness.store.reap();

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM polls WHERE chat_id = $1`, [group.id]
    );
    assert.equal(rows[0].n, 0, 'polls do not outlive their message');
  });
});

describe('folders', () => {
  test('creates a folder and assigns chats', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id },
    })).json();

    const folder = (await app.inject({
      method: 'POST', url: '/api/folders',
      headers: { cookie: alice.cookie }, payload: { title: 'Work', emoji: '💼' },
    })).json();

    await app.inject({
      method: 'PUT', url: `/api/folders/${folder.id}/chats`,
      headers: { cookie: alice.cookie }, payload: { chatIds: [chat.id] },
    });

    const folders = (await app.inject({
      method: 'GET', url: '/api/folders', headers: { cookie: alice.cookie },
    })).json().folders;

    assert.equal(folders.length, 1);
    assert.deepEqual(folders[0].chatIds, [chat.id]);
  });

  test('a folder cannot reference a chat you are not in', async () => {
    // Otherwise a folder becomes a way to hold a reference to a conversation
    // you have no access to.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const dave = await registerUser(app);

    const theirs = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: carol.cookie }, payload: { peerId: dave.id },
    })).json();

    const folder = (await app.inject({
      method: 'POST', url: '/api/folders',
      headers: { cookie: alice.cookie }, payload: { title: 'Sneaky' },
    })).json();

    await app.inject({
      method: 'PUT', url: `/api/folders/${folder.id}/chats`,
      headers: { cookie: alice.cookie }, payload: { chatIds: [theirs.id] },
    });

    const folders = (await app.inject({
      method: 'GET', url: '/api/folders', headers: { cookie: alice.cookie },
    })).json().folders;
    assert.deepEqual(folders[0].chatIds, [], 'the foreign chat was not added');
    void bob;
  });

  test('folders are private to their owner', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    await app.inject({
      method: 'POST', url: '/api/folders',
      headers: { cookie: alice.cookie }, payload: { title: 'Mine' },
    });

    const bobFolders = (await app.inject({
      method: 'GET', url: '/api/folders', headers: { cookie: bob.cookie },
    })).json().folders;
    assert.equal(bobFolders.length, 0);
  });

  test('another user cannot modify your folder', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const folder = (await app.inject({
      method: 'POST', url: '/api/folders',
      headers: { cookie: alice.cookie }, payload: { title: 'Mine' },
    })).json();

    const res = await app.inject({
      method: 'PUT', url: `/api/folders/${folder.id}/chats`,
      headers: { cookie: bob.cookie }, payload: { chatIds: [] },
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('scheduled messages', () => {
  test('the database refuses a schedule beyond the retention window', async () => {
    // A message scheduled for next week would be reaped before it fired, so
    // accepting one would be accepting a send that can never happen.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id },
    })).json();

    await assert.rejects(
      harness.store.pool.query(
        `INSERT INTO messages (chat_id, seq, sender_id, ciphertext, body, sent_at, scheduled_at, expires_at)
         VALUES ($1, 999, $2, '', 'too far out', now(), now() + interval '7 days', now() + interval '1 hour')`,
        [chat.id, alice.id]
      ),
      /scheduled_within_retention|check constraint/i
    );
  });

  test('releasing a scheduled message restarts its lifetime from delivery', async () => {
    // Otherwise a message scheduled for +23h would expire an hour after
    // arriving, which is not what "expires 24h after it was sent" means.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id },
    })).json();

    const { rows } = await harness.store.pool.query(
      `INSERT INTO messages (chat_id, seq, sender_id, ciphertext, body, sent_at, scheduled_at, expires_at)
       VALUES ($1, 1, $2, '', 'later', now(), now() - interval '1 second', now() + interval '1 hour')
       RETURNING id`,
      [chat.id, alice.id]
    );

    const due = await harness.store.phase3.dueScheduledMessages();
    assert.equal(due.length, 1);

    const released = await harness.store.phase3.releaseScheduledMessage(rows[0].id);
    const lifetime = new Date(released.expires_at) - Date.now();

    assert.ok(lifetime > 23 * 3600 * 1000, 'a full window from delivery');
    assert.ok(lifetime <= 24 * 3600 * 1000 + 5000, 'and still capped at 24h');
  });
});
