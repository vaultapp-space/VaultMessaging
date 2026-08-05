import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

// A 1x1 PNG, enough to exercise the upload/serve path without a fixture.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

async function makeGroup(owner, members) {
  const res = await app.inject({
    method: 'POST', url: '/api/groups',
    headers: { cookie: owner.cookie },
    payload: { name: 'Group', members: members.map((m) => m.id) },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function startVoice(user, chatId) {
  return app.inject({
    method: 'POST', url: `/api/chats/${chatId}/voice`,
    headers: { cookie: user.cookie }, payload: {},
  });
}

function joinVoice(user, voiceChatId) {
  return app.inject({
    method: 'POST', url: `/api/voice/${voiceChatId}/join`,
    headers: { cookie: user.cookie },
  });
}

// ============================================================
// Voice chats
// ============================================================

describe('voice chats', () => {
  test('starting a call twice returns the same call', async () => {
    // A partial unique index enforces one live call per chat: two people
    // pressing "start" together must not create two rooms that each think
    // they are the call.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const first = (await startVoice(owner, group.id)).json();
    const second = (await startVoice(member, group.id)).json();

    assert.equal(first.id, second.id);
  });

  test('participants can join and appear in the list', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const call = (await startVoice(owner, group.id)).json();

    await joinVoice(owner, call.id);
    const joined = await joinVoice(member, call.id);
    assert.equal(joined.statusCode, 200, joined.body);

    const { participants } = joined.json();
    assert.equal(participants.length, 2);
  });

  test('the participant cap is enforced', async () => {
    // The media plane is a 1:1 mesh, which is O(n^2) connections. The cap is
    // the honest version of that limit: a call that says it holds four beats
    // one that quietly falls apart at eight.
    const owner = await registerUser(app);
    const others = [];
    for (let i = 0; i < 5; i++) others.push(await registerUser(app));
    const group = await makeGroup(owner, others);
    const call = (await startVoice(owner, group.id)).json();

    const max = call.maxParticipants;
    assert.ok(max > 0, 'the cap is reported to the client');

    const results = [];
    for (const user of [owner, ...others]) {
      results.push((await joinVoice(user, call.id)).statusCode);
    }

    assert.equal(results.filter((s) => s === 200).length, max);
    assert.ok(results.includes(409), 'the overflow is refused, not silently dropped');
  });

  test('a non-member cannot join a call', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const stranger = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const call = (await startVoice(owner, group.id)).json();

    const res = await joinVoice(stranger, call.id);
    assert.equal(res.statusCode, 404);
  });

  test('the call ends when the last participant leaves', async () => {
    // A live call nobody is in is worse than no call: people join it
    // expecting to find someone.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const call = (await startVoice(owner, group.id)).json();
    await joinVoice(owner, call.id);

    const left = await app.inject({
      method: 'POST', url: `/api/voice/${call.id}/leave`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(left.json().remaining, 0);

    const view = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/voice`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.equal(view.voiceChat, null);
  });

  test('a participant can mute themselves', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const call = (await startVoice(owner, group.id)).json();
    await joinVoice(member, call.id);

    const res = await app.inject({
      method: 'PATCH', url: `/api/voice/${call.id}/mute`,
      headers: { cookie: member.cookie }, payload: { muted: true },
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  test('an admin mute cannot be undone by the person muted', async () => {
    // The one thing moderation muting exists for. Collapsing admin mute and
    // self mute into one flag would make it useless.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    const call = (await startVoice(owner, group.id)).json();
    await joinVoice(member, call.id);

    const muted = await app.inject({
      method: 'PATCH', url: `/api/voice/${call.id}/mute`,
      headers: { cookie: owner.cookie },
      payload: { muted: true, userId: member.id },
    });
    assert.equal(muted.statusCode, 200, muted.body);

    const unmute = await app.inject({
      method: 'PATCH', url: `/api/voice/${call.id}/mute`,
      headers: { cookie: member.cookie }, payload: { muted: false },
    });
    assert.equal(unmute.statusCode, 403);
  });

  test('an ordinary member cannot mute someone else', async () => {
    const owner = await registerUser(app);
    const a = await registerUser(app);
    const b = await registerUser(app);
    const group = await makeGroup(owner, [a, b]);
    const call = (await startVoice(owner, group.id)).json();
    await joinVoice(a, call.id);
    await joinVoice(b, call.id);

    const res = await app.inject({
      method: 'PATCH', url: `/api/voice/${call.id}/mute`,
      headers: { cookie: a.cookie }, payload: { muted: true, userId: b.id },
    });
    assert.equal(res.statusCode, 403);
  });
});

// ============================================================
// Forum topics
// ============================================================

describe('forum topics', () => {
  async function forumGroup() {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/forum`,
      headers: { cookie: owner.cookie }, payload: { isForum: true },
    });
    return { owner, member, group };
  }

  test('a topic can be created in a forum group', async () => {
    const { owner, group } = await forumGroup();

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Announcements', iconEmoji: '📣' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().title, 'Announcements');
  });

  test('a chat that is not a forum refuses topics', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'Nope' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('topics list with pinned ones first', async () => {
    const { owner, group } = await forumGroup();

    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'General' },
    });
    const second = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'Rules' },
    })).json();

    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/topics/${second.topicId}`,
      headers: { cookie: owner.cookie }, payload: { pinned: true },
    });

    const { topics } = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.equal(topics[0].title, 'Rules');
  });

  test('an ordinary member cannot close or pin a topic', async () => {
    // Closing a topic is moderation, so it needs the pin right rather than
    // mere membership.
    const { owner, member, group } = await forumGroup();
    const topic = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'General' },
    })).json();

    const res = await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/topics/${topic.topicId}`,
      headers: { cookie: member.cookie }, payload: { closed: true },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a non-member cannot see the topic list', async () => {
    const { group } = await forumGroup();
    const stranger = await registerUser(app);

    const res = await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================
// Stories
// ============================================================

describe('stories', () => {
  function postStory(user, overrides = {}) {
    return app.inject({
      method: 'POST', url: '/api/stories',
      headers: { cookie: user.cookie },
      payload: { media: { fileId: 'abc', kind: 'photo' }, ...overrides },
    });
  }

  function feed(user) {
    return app.inject({
      method: 'GET', url: '/api/stories', headers: { cookie: user.cookie },
    });
  }

  test('a story appears in its author\'s own feed', async () => {
    const alice = await registerUser(app);
    const posted = await postStory(alice, { caption: 'hello' });
    assert.equal(posted.statusCode, 201, posted.body);

    const { stories } = (await feed(alice)).json();
    assert.equal(stories.length, 1);
    assert.equal(stories[0].caption, 'hello');
  });

  test('a "contacts" story is hidden from strangers', async () => {
    // The default. Privacy is applied in the query rather than filtered
    // afterwards, so no code path can forget it.
    const alice = await registerUser(app);
    const stranger = await registerUser(app);
    await postStory(alice, { privacy: 'contacts' });

    const { stories } = (await feed(stranger)).json();
    assert.equal(stories.length, 0);
  });

  test('a "contacts" story is visible to a contact', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    await app.inject({
      method: 'POST', url: `/api/contacts/${bob.id}`,
      headers: { cookie: alice.cookie }, payload: {},
    });
    await postStory(alice, { privacy: 'contacts' });

    const { stories } = (await feed(bob)).json();
    assert.equal(stories.length, 1);
  });

  test('an "everyone" story is visible to anyone', async () => {
    const alice = await registerUser(app);
    const stranger = await registerUser(app);
    await postStory(alice, { privacy: 'everyone' });

    const { stories } = (await feed(stranger)).json();
    assert.equal(stories.length, 1);
  });

  test('a blocked user never sees a story', async () => {
    const alice = await registerUser(app);
    const blocked = await registerUser(app);
    await app.inject({
      method: 'POST', url: `/api/users/${blocked.id}/block`,
      headers: { cookie: alice.cookie },
    });
    await postStory(alice, { privacy: 'everyone' });

    const { stories } = (await feed(blocked)).json();
    assert.equal(stories.length, 0);
  });

  test('the author sees who viewed, and nobody else does', async () => {
    const alice = await registerUser(app);
    const viewer = await registerUser(app);
    const story = (await postStory(alice, { privacy: 'everyone' })).json();

    await app.inject({
      method: 'POST', url: `/api/stories/${story.id}/view`,
      headers: { cookie: viewer.cookie },
    });

    const mine = (await app.inject({
      method: 'GET', url: `/api/stories/${story.id}/viewers`,
      headers: { cookie: alice.cookie },
    })).json();
    assert.equal(mine.viewers.length, 1);
    assert.equal(mine.viewers[0].username, viewer.username);

    // Scoped to the author inside the query: who looked at your story is
    // yours, who looked at someone else's is not.
    const theirs = (await app.inject({
      method: 'GET', url: `/api/stories/${story.id}/viewers`,
      headers: { cookie: viewer.cookie },
    })).json();
    assert.equal(theirs.viewers.length, 0);
  });

  test('viewing a story you cannot see is refused', async () => {
    // Recording the view would both leak the story's existence and put the
    // caller's name in someone else's viewer list.
    const alice = await registerUser(app);
    const stranger = await registerUser(app);
    const story = (await postStory(alice, { privacy: 'contacts' })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/stories/${story.id}/view`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a story cannot outlive the 24h ceiling', async () => {
    // "24 hours" being a story's own convention makes it tempting to treat
    // this as a special case. It is not one.
    const alice = await registerUser(app);
    await postStory(alice);

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM stories
        WHERE expires_at IS NULL OR expires_at > now() + interval '24 hours'`
    );
    assert.equal(rows[0].n, 0);
  });

  test('the reaper removes expired stories and their view rows', async () => {
    const alice = await registerUser(app);
    const viewer = await registerUser(app);
    const story = (await postStory(alice, { privacy: 'everyone' })).json();
    await app.inject({
      method: 'POST', url: `/api/stories/${story.id}/view`,
      headers: { cookie: viewer.cookie },
    });

    await harness.store.pool.query(
      `UPDATE stories SET expires_at = now() - interval '1 hour'`
    );
    await harness.store.reap();

    const stories = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM stories`
    );
    assert.equal(stories.rows[0].n, 0);

    // The viewer list must not survive the story: it would be a record of who
    // looked at something that no longer exists.
    const views = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM story_views`
    );
    assert.equal(views.rows[0].n, 0);
  });

  test('a story image is deleted from disk when the story expires', async () => {
    // The one retention hole a story could have. Its file goes through the
    // *public* media path — not the expiring attachment path — so nothing
    // else would ever remove it. Left alone the image would outlive the row
    // and stay reachable by anyone who kept the URL.
    const alice = await registerUser(app);

    const upload = (await app.inject({
      method: 'POST', url: '/api/media/upload',
      headers: { cookie: alice.cookie },
      payload: { mimeType: 'image/png', data: TINY_PNG },
    })).json();

    await postStory(alice, {
      media: { kind: 'photo', fileId: upload.fileId, mimeType: 'image/png' },
    });

    const filePath = path.join(harness.store.uploadsDir, 'media', `${upload.fileId}.png`);
    assert.ok(fs.existsSync(filePath), 'the image is on disk to begin with');

    await harness.store.pool.query(
      `UPDATE stories SET expires_at = now() - interval '1 hour'`
    );
    await harness.store.reap();

    assert.equal(fs.existsSync(filePath), false, 'and is gone with the story');

    // And the server no longer serves it. Media is authenticated now, so the
    // request carries a session — otherwise this would 401 and prove nothing.
    const res = await app.inject({
      method: 'GET', url: `/api/media/${upload.fileId}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 404);
  });

  test('a sticker image is not deleted by the reaper', async () => {
    // The other half of the same rule: a sticker set is a library the user
    // installed, so its files persist. Only story files are reaped.
    const alice = await registerUser(app);
    const upload = (await app.inject({
      method: 'POST', url: '/api/media/upload',
      headers: { cookie: alice.cookie },
      payload: { mimeType: 'image/png', data: TINY_PNG },
    })).json();

    await harness.store.reap();

    const res = await app.inject({
      method: 'GET', url: `/api/media/${upload.fileId}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(res.statusCode, 200);
  });

  test('a story image is not readable by someone outside its audience', async () => {
    // The story row was privacy-scoped but its image was served by an
    // unauthenticated endpoint, so a "contacts only" story's picture was
    // readable by anyone holding the URL and the privacy setting governed
    // only the caption.
    const alice = await registerUser(app);
    const stranger = await registerUser(app);

    const upload = (await app.inject({
      method: 'POST', url: '/api/media/upload',
      headers: { cookie: alice.cookie },
      payload: { mimeType: 'image/png', data: TINY_PNG },
    })).json();

    await postStory(alice, {
      media: { kind: 'photo', fileId: upload.fileId, mimeType: 'image/png' },
      privacy: 'contacts',
    });

    const refused = await app.inject({
      method: 'GET', url: `/api/media/${upload.fileId}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(refused.statusCode, 404, 'a stranger must not get the bytes');

    const mine = await app.inject({
      method: 'GET', url: `/api/media/${upload.fileId}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(mine.statusCode, 200, 'the author still can');
  });

  test('media requires a session at all', async () => {
    const alice = await registerUser(app);
    const upload = (await app.inject({
      method: 'POST', url: '/api/media/upload',
      headers: { cookie: alice.cookie },
      payload: { mimeType: 'image/png', data: TINY_PNG },
    })).json();

    const res = await app.inject({ method: 'GET', url: `/api/media/${upload.fileId}` });
    assert.equal(res.statusCode, 401);
  });

  test('a sticker image stays readable by any signed-in user', async () => {
    // Sticker sets are shared libraries; only story images carry an audience.
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const upload = (await app.inject({
      method: 'POST', url: '/api/media/upload',
      headers: { cookie: owner.cookie },
      payload: { mimeType: 'image/png', data: TINY_PNG },
    })).json();

    const res = await app.inject({
      method: 'GET', url: `/api/media/${upload.fileId}`,
      headers: { cookie: other.cookie },
    });
    assert.equal(res.statusCode, 200);
  });

  test('only the author can delete a story', async () => {
    const alice = await registerUser(app);
    const stranger = await registerUser(app);
    const story = (await postStory(alice, { privacy: 'everyone' })).json();

    const refused = await app.inject({
      method: 'DELETE', url: `/api/stories/${story.id}`,
      headers: { cookie: stranger.cookie },
    });
    assert.equal(refused.statusCode, 404);

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/stories/${story.id}`,
      headers: { cookie: alice.cookie },
    });
    assert.equal(deleted.statusCode, 200);
  });
});

// ============================================================
// Topic-scoped messages
// ============================================================
// A forum's topics are separate conversations, not one interleaved stream.
// The filter is what makes that true.

describe('messages in topics', () => {
  test('a message sent to a topic is only returned for that topic', async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/forum`,
      headers: { cookie: owner.cookie }, payload: { isForum: true },
    });

    const general = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'General' },
    })).json();
    const rules = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'Rules' },
    })).json();

    const send = (topicId, body) => app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: owner.cookie }, payload: { body, topicId },
    });

    await send(general.topicId, 'in general');
    await send(rules.topicId, 'in rules');
    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: owner.cookie }, payload: { body: 'untagged' },
    });

    const inGeneral = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/messages?topicId=${general.topicId}`,
      headers: { cookie: member.cookie },
    })).json();
    assert.deepEqual(inGeneral.messages.map((m) => m.body), ['in general']);

    // Without the filter the whole chat comes back, which is what every
    // non-forum caller wants.
    const all = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: member.cookie },
    })).json();
    assert.equal(all.messages.length, 3);
  });

  test('the first message in a topic becomes its root', async () => {
    // So a deep link into a topic has something to point at.
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const group = await makeGroup(owner, [member]);
    await harness.store.pool.query(`UPDATE chats SET mode = 'cloud' WHERE id = $1`, [group.id]);
    await app.inject({
      method: 'PATCH', url: `/api/chats/${group.id}/forum`,
      headers: { cookie: owner.cookie }, payload: { isForum: true },
    });

    const topic = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie }, payload: { title: 'General' },
    })).json();
    assert.equal(topic.rootSeq, null, 'a topic can exist before anyone posts');

    const first = (await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: owner.cookie },
      payload: { body: 'first post', topicId: topic.topicId },
    })).json();
    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: owner.cookie },
      payload: { body: 'second post', topicId: topic.topicId },
    });

    const { topics } = (await app.inject({
      method: 'GET', url: `/api/chats/${group.id}/topics`,
      headers: { cookie: owner.cookie },
    })).json();
    const updated = topics.find((t) => t.topicId === topic.topicId);
    assert.equal(updated.rootSeq, first.seq, 'the root does not move to later messages');
  });
});
