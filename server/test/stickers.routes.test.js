import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

let seq = 0;
function shortName() {
  return `set${(seq += 1)}${Date.now().toString(36)}`;
}

async function makeSet(owner, overrides = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/stickers/sets',
    headers: { cookie: owner.cookie },
    payload: { shortName: shortName(), title: 'Cats', ...overrides },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function addSticker(owner, setId, emoji = '😺') {
  const res = await app.inject({
    method: 'POST', url: `/api/stickers/sets/${setId}/stickers`,
    headers: { cookie: owner.cookie },
    payload: { fileId: crypto.randomUUID(), emoji, width: 512, height: 512 },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

function picker(user) {
  return app.inject({
    method: 'GET', url: '/api/stickers', headers: { cookie: user.cookie },
  });
}

// ============================================================
// Sets
// ============================================================

describe('sticker sets', () => {
  test('creating a set installs it for the creator', async () => {
    // Otherwise making a set leaves you unable to use it without searching
    // for your own work.
    const owner = await registerUser(app);
    const set = await makeSet(owner);

    const { sets } = (await picker(owner)).json();
    assert.equal(sets.length, 1);
    assert.equal(sets[0].id, set.id);
  });

  test('a duplicate short name is refused', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const name = shortName();

    await makeSet(owner, { shortName: name });
    const res = await app.inject({
      method: 'POST', url: '/api/stickers/sets',
      headers: { cookie: other.cookie },
      payload: { shortName: name, title: 'Impostor' },
    });
    assert.equal(res.statusCode, 409);
  });

  test('only the owner can add stickers to a set', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const set = await makeSet(owner);

    const res = await app.inject({
      method: 'POST', url: `/api/stickers/sets/${set.id}/stickers`,
      headers: { cookie: stranger.cookie },
      payload: { fileId: crypto.randomUUID(), emoji: '🙃' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a set is fetchable by short name with its stickers', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const name = shortName();
    const set = await makeSet(owner, { shortName: name });
    await addSticker(owner, set.id);
    await addSticker(owner, set.id, '😸');

    const res = await app.inject({
      method: 'GET', url: `/api/stickers/sets/${name}`,
      headers: { cookie: reader.cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.stickers.length, 2);
    assert.equal(body.installed, false);
  });

  test('stickers keep the order they were added in', async () => {
    const owner = await registerUser(app);
    const name = shortName();
    const set = await makeSet(owner, { shortName: name });
    const first = await addSticker(owner, set.id, '1️⃣');
    const second = await addSticker(owner, set.id, '2️⃣');

    const { stickers } = (await app.inject({
      method: 'GET', url: `/api/stickers/sets/${name}`,
      headers: { cookie: owner.cookie },
    })).json();
    assert.deepEqual(stickers.map((s) => s.id), [first.id, second.id]);
  });
});

// ============================================================
// Installation
// ============================================================

describe('installing sets', () => {
  test('installing adds the set to the picker and counts once', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const set = await makeSet(owner);
    await addSticker(owner, set.id);

    await app.inject({
      method: 'POST', url: `/api/stickers/sets/${set.id}/install`,
      headers: { cookie: reader.cookie },
    });
    // Installing twice must not inflate the counter.
    await app.inject({
      method: 'POST', url: `/api/stickers/sets/${set.id}/install`,
      headers: { cookie: reader.cookie },
    });

    const { sets } = (await picker(reader)).json();
    assert.equal(sets.length, 1);
    assert.equal(sets[0].stickers.length, 1);

    const { rows } = await harness.store.pool.query(
      `SELECT installs_count FROM sticker_sets WHERE id = $1`, [set.id]
    );
    assert.equal(rows[0].installs_count, 2, 'the owner plus one reader');
  });

  test('uninstalling removes it and decrements the counter', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    const set = await makeSet(owner);

    await app.inject({
      method: 'POST', url: `/api/stickers/sets/${set.id}/install`,
      headers: { cookie: reader.cookie },
    });
    await app.inject({
      method: 'DELETE', url: `/api/stickers/sets/${set.id}/install`,
      headers: { cookie: reader.cookie },
    });

    const { sets } = (await picker(reader)).json();
    assert.equal(sets.length, 0);

    const { rows } = await harness.store.pool.query(
      `SELECT installs_count FROM sticker_sets WHERE id = $1`, [set.id]
    );
    assert.equal(rows[0].installs_count, 1);
  });

  test('a set can be found by search', async () => {
    const owner = await registerUser(app);
    const reader = await registerUser(app);
    await makeSet(owner, { title: 'Distinctive Penguins' });

    const { sets } = (await app.inject({
      method: 'GET', url: '/api/stickers/search?q=Penguins',
      headers: { cookie: reader.cookie },
    })).json();
    assert.equal(sets.length, 1);
  });
});

// ============================================================
// Favourites and recents
// ============================================================

describe('favourites and recents', () => {
  test('a sticker can be favourited and unfavourited', async () => {
    const owner = await registerUser(app);
    const set = await makeSet(owner);
    const sticker = await addSticker(owner, set.id);

    await app.inject({
      method: 'POST', url: `/api/stickers/${sticker.id}/favorite`,
      headers: { cookie: owner.cookie },
    });
    let { favorites } = (await picker(owner)).json();
    assert.equal(favorites.length, 1);

    await app.inject({
      method: 'DELETE', url: `/api/stickers/${sticker.id}/favorite`,
      headers: { cookie: owner.cookie },
    });
    ({ favorites } = (await picker(owner)).json());
    assert.equal(favorites.length, 0);
  });

  test('using a sticker records it as recent, most recent first', async () => {
    const owner = await registerUser(app);
    const set = await makeSet(owner);
    const a = await addSticker(owner, set.id, '🅰️');
    const b = await addSticker(owner, set.id, '🅱️');

    for (const id of [a.id, b.id]) {
      await app.inject({
        method: 'POST', url: `/api/stickers/${id}/use`,
        headers: { cookie: owner.cookie },
      });
    }

    const { recents } = (await picker(owner)).json();
    assert.equal(recents[0].id, b.id);
  });

  test('recents are capped rather than growing forever', async () => {
    // The cap is a privacy control, not housekeeping: unbounded, this becomes
    // a durable record of what someone has been sending, which is exactly the
    // metadata the rest of the product refuses to keep.
    const owner = await registerUser(app);
    const set = await makeSet(owner);

    for (let i = 0; i < 25; i++) {
      const sticker = await addSticker(owner, set.id, `e${i}`);
      await app.inject({
        method: 'POST', url: `/api/stickers/${sticker.id}/use`,
        headers: { cookie: owner.cookie },
      });
    }

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM recent_stickers WHERE user_id = $1`, [owner.id]
    );
    assert.ok(rows[0].n <= 20, `recents must stay capped, got ${rows[0].n}`);
  });

  test('recents can be cleared', async () => {
    const owner = await registerUser(app);
    const set = await makeSet(owner);
    const sticker = await addSticker(owner, set.id);
    await app.inject({
      method: 'POST', url: `/api/stickers/${sticker.id}/use`,
      headers: { cookie: owner.cookie },
    });

    await app.inject({
      method: 'DELETE', url: '/api/stickers/recents',
      headers: { cookie: owner.cookie },
    });
    const { recents } = (await picker(owner)).json();
    assert.equal(recents.length, 0);
  });

  test('one user\'s recents are not another\'s', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const set = await makeSet(owner);
    const sticker = await addSticker(owner, set.id);
    await app.inject({
      method: 'POST', url: `/api/stickers/${sticker.id}/use`,
      headers: { cookie: owner.cookie },
    });

    const { recents } = (await picker(other)).json();
    assert.equal(recents.length, 0);
  });
});

// ============================================================
// Suggestion
// ============================================================

describe('emoji suggestion', () => {
  test('typing an emoji suggests matching stickers from installed sets', async () => {
    const owner = await registerUser(app);
    const set = await makeSet(owner);
    await addSticker(owner, set.id, '🎉');

    const { stickers } = (await app.inject({
      method: 'GET', url: '/api/stickers/suggest?emoji=%F0%9F%8E%89',
      headers: { cookie: owner.cookie },
    })).json();
    assert.equal(stickers.length, 1);
  });

  test('sets the user has not installed are never suggested', async () => {
    // Otherwise the picker offers stickers that cannot be sent, and tells
    // someone who installed nothing which sets exist.
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const set = await makeSet(owner);
    await addSticker(owner, set.id, '🎉');

    const { stickers } = (await app.inject({
      method: 'GET', url: '/api/stickers/suggest?emoji=%F0%9F%8E%89',
      headers: { cookie: stranger.cookie },
    })).json();
    assert.equal(stickers.length, 0);
  });
});

// ============================================================
// Retention
// ============================================================

describe('stickers and the 24h rule', () => {
  test('a sticker set survives the reaper', async () => {
    // A set is a library the user installed, not message content, and it
    // reveals nothing about any conversation.
    const owner = await registerUser(app);
    const set = await makeSet(owner);
    await addSticker(owner, set.id);

    await harness.store.reap();

    const { sets } = (await picker(owner)).json();
    assert.equal(sets.length, 1);
    assert.equal(sets[0].stickers.length, 1);
  });

  test('a sticker sent in a chat expires like any other message', async () => {
    // The message stores a reference, not a copy, so the message expiring
    // leaves the set alone — and the set existing tells nobody it was used.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const owner = alice;
    const set = await makeSet(owner);
    const sticker = await addSticker(owner, set.id);

    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { type: 'sticker', media: { stickerId: sticker.id } },
    });

    const { rows } = await harness.store.pool.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE chat_id = $1 AND (expires_at IS NULL
              OR expires_at > now() + interval '24 hours')`,
      [chat.id]
    );
    assert.equal(rows[0].n, 0, 'a sticker message is not exempt from expiry');

    await harness.store.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 hour' WHERE chat_id = $1`,
      [chat.id]
    );
    await harness.store.reap();

    // The set is untouched.
    const { sets } = (await picker(owner)).json();
    assert.equal(sets[0].stickers.length, 1);
  });
});
