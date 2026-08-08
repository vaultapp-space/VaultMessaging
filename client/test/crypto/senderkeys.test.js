import { describe, test, expect } from 'vitest';

import { SenderKeySession } from '../../src/lib/crypto/senderkeys.js';

const GROUP = 'group-1';

// A sender creates their own key; every other member imports the
// distribution package over their existing pairwise ratchet channel.
async function senderWithMembers(memberCount) {
  const sender = new SenderKeySession('alice', GROUP);
  await sender.initSelf();

  const pack = await sender.exportDistributionPackage();
  const members = [];
  for (let i = 0; i < memberCount; i += 1) {
    const member = new SenderKeySession('alice', GROUP);
    await member.importDistributionPackage(pack);
    members.push(member);
  }

  return { sender, members };
}

describe('Sender Keys', () => {
  test('a member decrypts a message from the sender', async () => {
    const { sender, members: [bob] } = await senderWithMembers(1);

    const packet = await sender.encrypt('hello group');
    expect(await bob.decrypt(packet)).toBe('hello group');
  });

  test('every member decrypts the same packet', async () => {
    const { sender, members } = await senderWithMembers(4);

    const packet = await sender.encrypt('broadcast');
    for (const member of members) {
      expect(await member.decrypt(packet)).toBe('broadcast');
    }
  });

  test('a run of messages decrypts in order', async () => {
    const { sender, members: [bob] } = await senderWithMembers(1);

    for (let i = 0; i < 10; i += 1) {
      const packet = await sender.encrypt(`m${i}`);
      expect(await bob.decrypt(packet)).toBe(`m${i}`);
    }
  });

  test('the packet carries routing metadata but no plaintext', async () => {
    const { sender } = await senderWithMembers(0);

    const packet = await sender.encrypt('secret payload');

    expect(packet.groupId).toBe(GROUP);
    expect(packet.senderId).toBe('alice');
    expect(packet.messageNumber).toBe(0);
    expect(JSON.stringify(packet)).not.toContain('secret payload');
  });

  test('message numbers advance', async () => {
    const { sender } = await senderWithMembers(0);

    const a = await sender.encrypt('one');
    const b = await sender.encrypt('two');

    expect(a.messageNumber).toBe(0);
    expect(b.messageNumber).toBe(1);
  });

  test('out-of-order messages still decrypt', async () => {
    const { sender, members: [bob] } = await senderWithMembers(1);

    const m0 = await sender.encrypt('m0');
    const m1 = await sender.encrypt('m1');
    const m2 = await sender.encrypt('m2');

    expect(await bob.decrypt(m2)).toBe('m2');
    expect(await bob.decrypt(m0)).toBe('m0');
    expect(await bob.decrypt(m1)).toBe('m1');
  });

  test('refuses to skip an unbounded gap (DoS regression)', async () => {
    // Regression test: this loop used to have no cap at all — one packet
    // with messageNumber set far ahead made every member's client
    // synchronously derive that many keys, growing skippedKeys without
    // bound. A single crafted (or buggy) group message was a one-shot DoS
    // against every other member.
    const { sender, members: [bob] } = await senderWithMembers(1);

    // Advance the sender's real counter without going through bob, so the
    // forged-looking gap is genuine rather than a signature mismatch.
    for (let i = 0; i < 150; i += 1) {
      await sender.encrypt(`m${i}`);
    }
    const farAhead = await sender.encrypt('too far ahead');

    await expect(bob.decrypt(farAhead)).rejects.toThrow(/gap too large/i);
    // Must not have derived and stored 150+ skipped keys while failing.
    expect(bob.skippedKeys.size).toBe(0);
  });

  test('a forged signature is rejected', async () => {
    // Sender Keys are symmetric, so every member could otherwise forge
    // messages as the sender. The ECDSA signature is what prevents that.
    const { members: [bob] } = await senderWithMembers(1);

    const impostor = new SenderKeySession('alice', GROUP);
    await impostor.initSelf();
    const forged = await impostor.encrypt('I am alice');

    // Same chain position, but signed with the wrong key.
    await expect(bob.decrypt({ ...forged, messageNumber: 0 })).rejects.toThrow();
  });

  test('tampered ciphertext is rejected', async () => {
    const { sender, members: [bob] } = await senderWithMembers(1);

    const packet = await sender.encrypt('authentic');
    const bytes = atob(packet.ciphertext).split('').map((c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered = { ...packet, ciphertext: btoa(String.fromCharCode(...bytes)) };

    await expect(bob.decrypt(tampered)).rejects.toThrow();
  });

  test('a non-member cannot decrypt', async () => {
    const { sender } = await senderWithMembers(0);
    const outsider = new SenderKeySession('alice', GROUP);
    await outsider.initSelf();

    const packet = await sender.encrypt('members only');
    await expect(outsider.decrypt(packet)).rejects.toThrow();
  });

  test('a rotated key cannot decrypt messages from the old key', async () => {
    // This is what makes leaving/removal meaningful: after rotation, the
    // departed member's copy of the old chain key is useless for new traffic.
    const { sender, members: [bob] } = await senderWithMembers(1);

    await sender.initSelf(); // rotate
    const afterRotation = await sender.encrypt('post-rotation');

    await expect(bob.decrypt(afterRotation)).rejects.toThrow();

    // ...and a member who receives the new distribution package recovers.
    await bob.importDistributionPackage(await sender.exportDistributionPackage());
    const next = await sender.encrypt('post-redistribution');
    expect(await bob.decrypt(next)).toBe('post-redistribution');
  });

  test('rotation produces a genuinely different chain key', async () => {
    const sender = new SenderKeySession('alice', GROUP);
    await sender.initSelf();
    const first = await sender.exportDistributionPackage();

    await sender.initSelf();
    const second = await sender.exportDistributionPackage();

    expect(second.chainKey).not.toBe(first.chainKey);
    expect(second.signingPubKey).not.toBe(first.signingPubKey);
    expect(second.messageNumber).toBe(0);
  });

  test('encrypting without initialisation throws', async () => {
    const session = new SenderKeySession('alice', GROUP);
    await expect(session.encrypt('x')).rejects.toThrow(/not initialized/i);
  });

  test('decrypting without initialisation throws', async () => {
    const session = new SenderKeySession('alice', GROUP);
    await expect(
      session.decrypt({ messageNumber: 0, iv: '', ciphertext: '', signature: '' })
    ).rejects.toThrow(/not initialized/i);
  });

  test('a distribution package contains no private signing key', async () => {
    const { sender } = await senderWithMembers(0);
    const pack = await sender.exportDistributionPackage();

    expect(pack.signingPrivKey).toBeUndefined();
    expect(JSON.stringify(pack)).not.toContain('"d"'); // no JWK private scalar
  });

  test('round-trips unicode and large payloads', async () => {
    const { sender, members: [bob] } = await senderWithMembers(1);

    for (const payload of ['🔐 ünicode 中文', 'y'.repeat(50_000), '']) {
      const packet = await sender.encrypt(payload);
      expect(await bob.decrypt(packet)).toBe(payload);
    }
  });
});
