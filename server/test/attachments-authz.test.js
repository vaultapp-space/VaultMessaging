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

  test('referencing a file you have no access to does not grant it to a new recipient (1:1 send)', async () => {
    // Alice uploads a file and shares it with Bob only. Carol was never
    // authorised on it — she must not be able to hand herself (or anyone
    // else) access just by quoting the file's id in her own message.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);

    const up = (await app.inject({
      method: 'POST', url: '/api/attachments',
      headers: { cookie: alice.cookie },
      payload: { filename: 'x.bin', mimeType: 'application/octet-stream', ciphertext: 'AAAA' },
    })).json();

    await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: alice.cookie },
      payload: {
        recipientId: bob.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0, iv: 'i',
        attachmentId: up.id,
      },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/messages',
      headers: { cookie: carol.cookie },
      payload: {
        recipientId: carol.id, ciphertext: 'c', ephemeralKey: 'e', messageNumber: 0, iv: 'i',
        attachmentId: up.id,
      },
    });
    assert.equal(res.statusCode, 403, `expected the send to be rejected, got ${res.statusCode}: ${res.body}`);

    const dl = await app.inject({
      method: 'GET', url: `/api/attachments/${up.id}`, headers: { cookie: carol.cookie },
    });
    assert.equal(dl.statusCode, 403, 'Carol must still not be able to download the file');
  });

  test('referencing a file you have no access to does not grant it to a whole other chat', async () => {
    // Same attack via the cloud-chat send path: Carol was never authorised
    // on Alice's file, so quoting its id in an unrelated chat with Dave must
    // not authorise Dave either.
    const alice = await registerUser(app);
    const bob = await registerUser(app);
    const carol = await registerUser(app);
    const dave = await registerUser(app);

    const chatAB = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: alice.cookie }, payload: { peerId: bob.id, mode: 'cloud' },
    })).json();

    const up = (await app.inject({
      method: 'POST', url: '/api/attachments',
      headers: { cookie: alice.cookie },
      payload: { filename: 'x.bin', mimeType: 'application/octet-stream', ciphertext: 'AAAA' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${chatAB.id}/messages`,
      headers: { cookie: alice.cookie },
      payload: { type: 'document', media: { id: up.id, filename: 'x.bin' } },
    });

    const chatCD = (await app.inject({
      method: 'POST', url: '/api/chats/private',
      headers: { cookie: carol.cookie }, payload: { peerId: dave.id, mode: 'cloud' },
    })).json();

    await app.inject({
      method: 'POST', url: `/api/chats/${chatCD.id}/messages`,
      headers: { cookie: carol.cookie },
      payload: { type: 'document', media: { id: up.id, filename: 'x.bin' } },
    });

    const res = await app.inject({
      method: 'GET', url: `/api/attachments/${up.id}`, headers: { cookie: dave.cookie },
    });
    assert.equal(res.statusCode, 403, 'Dave must not gain access to a file from a chat he was never part of');
  });
});
