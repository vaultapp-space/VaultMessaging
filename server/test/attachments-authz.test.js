import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerUser, truncateAll } from './helpers/harness.js';

let harness, app;
before(async () => { harness = await createTestApp(); app = harness.app; });
after(async () => { await harness.close(); });
beforeEach(async () => { await truncateAll(harness.store); await harness.store.redis.flushdb(); });

// ============================================================
// Attachment authorisation
// ============================================================
// Files carry a per-file allowlist. Only the secret send path populated it,
// so a file sent in a cloud chat was uploaded, referenced by a message
// everyone could see, and then refused with a 403 to every recipient who
// tried to open it. Groups are all cloud, which made this every file shared
// in a group.

describe('attachments in cloud chats', () => {
  test('a recipient can download a file sent in a cloud chat', async () => {
    const alice = await registerUser(app);
    const bob = await registerUser(app);

    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    const up = (await app.inject({
      method: 'POST', url: '/api/attachments',
      headers: { cookie: alice.cookie },
      payload: { filename: 'x.bin', mimeType: 'application/octet-stream', ciphertext: 'AAAA' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { type: 'document', media: { id: up.id, filename: 'x.bin' } },
    });

    const res = await app.inject({
      method: 'GET', url: `/api/attachments/${up.id}`, headers: { cookie: bob.cookie },
    });
    assert.equal(res.statusCode, 200, `recipient got ${res.statusCode}: ${res.body}`);
  });

  test('someone outside the chat still cannot download it', async () => {
    // The allowlist is the access control, so widening it for members must
    // not widen it for everyone.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const outsider = await registerUser(app);

    const chat = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    const up = (await app.inject({
      method: 'POST', url: '/api/attachments',
      headers: { cookie: alice.cookie },
      payload: { filename: 'x.bin', mimeType: 'application/octet-stream', ciphertext: 'AAAA' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${chat.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { type: 'document', media: { id: up.id, filename: 'x.bin' } },
    });

    const res = await app.inject({
      method: 'GET', url: `/api/attachments/${up.id}`, headers: { cookie: outsider.cookie },
    });
    assert.equal(res.statusCode, 403);
  });

  test('a member who joins later does not gain access to older files', async () => {
    // Authorisation is granted to the members present when the file was
    // sent, not to the chat as a concept.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const latecomer = await registerUser(app);

    const group = (await app.inject({
      method: 'POST', url: '/api/groups',
      headers: { cookie: alice.cookie },
      payload: { name: 'G', members: [bob.id] },
    })).json();

    const up = (await app.inject({
      method: 'POST', url: '/api/attachments',
      headers: { cookie: alice.cookie },
      payload: { filename: 'x.bin', mimeType: 'application/octet-stream', ciphertext: 'AAAA' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${group.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { type: 'document', media: { id: up.id, filename: 'x.bin' } },
    });

    await harness.store.chats.addMember(group.id, latecomer.id);

    const res = await app.inject({
      method: 'GET', url: `/api/attachments/${up.id}`, headers: { cookie: latecomer.cookie },
    });
    assert.equal(res.statusCode, 403);
  });
});
