import { describe, test, expect } from 'vitest';

import { RatchetSession } from '../../src/lib/crypto/ratchet.js';
import { x3dhInitiate, x3dhRespond, deriveInitialKeys } from '../../src/lib/crypto/x3dh.js';
import { createIdentity } from '../helpers/identity.js';

// Builds a live pair of ratchet sessions the same way the app does: a real
// X3DH handshake, then sender/receiver initialisation from the derived keys.
async function establishPair() {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const { sharedSecret: aliceSecret, ephemeralPublicKey } =
    await x3dhInitiate(alice.identityKeyPair, bob.bundle);
  const { sharedSecret: bobSecret } = await x3dhRespond(
    bob.identityKeyPair, bob.signedPrekeyPair, bob.oneTimePrekeyPair,
    alice.identityKey, ephemeralPublicKey
  );

  const aliceKeys = await deriveInitialKeys(aliceSecret);
  const bobKeys = await deriveInitialKeys(bobSecret);

  const aliceSession = new RatchetSession();
  await aliceSession.initAsSender(
    aliceKeys.rootKey, aliceKeys.chainKey, bob.bundle.signedPrekey, bob.identityKey
  );

  const bobSession = new RatchetSession();
  await bobSession.initAsReceiver(
    bobKeys.rootKey, bobKeys.chainKey, bob.signedPrekeyPair, alice.identityKey
  );

  return { alice, bob, aliceSession, bobSession };
}

describe('Double Ratchet', () => {
  test('round-trips a single message', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const msg = await aliceSession.ratchetEncrypt('hello bob');
    const out = await bobSession.ratchetDecrypt(msg.header, msg.iv, msg.ciphertext);

    expect(out).toBe('hello bob');
  });

  test('round-trips a run of messages in order', async () => {
    const { aliceSession, bobSession } = await establishPair();

    for (let i = 0; i < 10; i += 1) {
      const msg = await aliceSession.ratchetEncrypt(`message ${i}`);
      const out = await bobSession.ratchetDecrypt(msg.header, msg.iv, msg.ciphertext);
      expect(out).toBe(`message ${i}`);
    }
  });

  test('produces different ciphertext for the same plaintext', async () => {
    const { aliceSession } = await establishPair();

    const a = await aliceSession.ratchetEncrypt('same');
    const b = await aliceSession.ratchetEncrypt('same');

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  test('advances the message number on each send', async () => {
    const { aliceSession } = await establishPair();

    const a = await aliceSession.ratchetEncrypt('one');
    const b = await aliceSession.ratchetEncrypt('two');

    expect(a.header.messageNumber).toBe(0);
    expect(b.header.messageNumber).toBe(1);
  });

  test('supports a full back-and-forth conversation with DH ratchet steps', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const a1 = await aliceSession.ratchetEncrypt('a1');
    expect(await bobSession.ratchetDecrypt(a1.header, a1.iv, a1.ciphertext)).toBe('a1');

    const b1 = await bobSession.ratchetEncrypt('b1');
    expect(await aliceSession.ratchetDecrypt(b1.header, b1.iv, b1.ciphertext)).toBe('b1');

    const a2 = await aliceSession.ratchetEncrypt('a2');
    expect(await bobSession.ratchetDecrypt(a2.header, a2.iv, a2.ciphertext)).toBe('a2');

    const b2 = await bobSession.ratchetEncrypt('b2');
    expect(await aliceSession.ratchetDecrypt(b2.header, b2.iv, b2.ciphertext)).toBe('b2');
  });

  test('rotates the ratchet public key after a reply', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const a1 = await aliceSession.ratchetEncrypt('a1');
    await bobSession.ratchetDecrypt(a1.header, a1.iv, a1.ciphertext);
    const b1 = await bobSession.ratchetEncrypt('b1');
    await aliceSession.ratchetDecrypt(b1.header, b1.iv, b1.ciphertext);

    const a2 = await aliceSession.ratchetEncrypt('a2');
    expect(a2.header.publicKey).not.toBe(a1.header.publicKey);
  });

  test('decrypts out-of-order messages within a chain', async () => {
    // Networks reorder; the ratchet must cache skipped message keys.
    const { aliceSession, bobSession } = await establishPair();

    const m0 = await aliceSession.ratchetEncrypt('m0');
    const m1 = await aliceSession.ratchetEncrypt('m1');
    const m2 = await aliceSession.ratchetEncrypt('m2');

    expect(await bobSession.ratchetDecrypt(m2.header, m2.iv, m2.ciphertext)).toBe('m2');
    expect(await bobSession.ratchetDecrypt(m0.header, m0.iv, m0.ciphertext)).toBe('m0');
    expect(await bobSession.ratchetDecrypt(m1.header, m1.iv, m1.ciphertext)).toBe('m1');
  });

  test('decrypts a message that arrives after a gap', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const m0 = await aliceSession.ratchetEncrypt('m0');
    await aliceSession.ratchetEncrypt('lost in transit');
    const m2 = await aliceSession.ratchetEncrypt('m2');

    expect(await bobSession.ratchetDecrypt(m0.header, m0.iv, m0.ciphertext)).toBe('m0');
    expect(await bobSession.ratchetDecrypt(m2.header, m2.iv, m2.ciphertext)).toBe('m2');
  });

  test('refuses a gap bigger than the skip limit without desyncing the chain', async () => {
    // Regression test: a gap over the 100-message skip cap used to still
    // force recvCount forward to match the arriving message, even though
    // recvChainKey had only actually been advanced 100 steps — permanently
    // desyncing the chain so every later message failed to decrypt too.
    // It must now throw for the one out-of-range message, and correctly
    // decrypt a normal one right after — proving the chain state is intact.
    const { aliceSession, bobSession } = await establishPair();

    for (let i = 0; i < 105; i += 1) {
      await aliceSession.ratchetEncrypt(`skipped ${i}`);
    }
    const farAhead = await aliceSession.ratchetEncrypt('too far ahead');

    await expect(
      bobSession.ratchetDecrypt(farAhead.header, farAhead.iv, farAhead.ciphertext)
    ).rejects.toThrow(/gap too large/i);

    // The chain must still work for a message within range afterwards.
    const recovery = await aliceSession.ratchetEncrypt('back to normal');
    // Bob is still only caught up to message 0 of the chain (nothing before
    // farAhead was ever delivered), so this is itself a >100 gap from his
    // perspective and is expected to also be refused — the point is that it
    // fails the *same clean way*, not with corrupted/garbage state.
    await expect(
      bobSession.ratchetDecrypt(recovery.header, recovery.iv, recovery.ciphertext)
    ).rejects.toThrow(/gap too large/i);
  });

  test('a gap right at the skip limit still decrypts normally', async () => {
    const { aliceSession, bobSession } = await establishPair();

    for (let i = 0; i < 100; i += 1) {
      await aliceSession.ratchetEncrypt(`skipped ${i}`);
    }
    const atLimit = await aliceSession.ratchetEncrypt('exactly at the limit');

    expect(await bobSession.ratchetDecrypt(atLimit.header, atLimit.iv, atLimit.ciphertext))
      .toBe('exactly at the limit');
  });

  test('decrypts messages that straddle a DH ratchet step out of order', async () => {
    const { aliceSession, bobSession } = await establishPair();

    // Alice sends two, Bob reads one, replies, then Alice sends across the step.
    const a1 = await aliceSession.ratchetEncrypt('a1');
    const a2 = await aliceSession.ratchetEncrypt('a2');
    await bobSession.ratchetDecrypt(a1.header, a1.iv, a1.ciphertext);

    const b1 = await bobSession.ratchetEncrypt('b1');
    await aliceSession.ratchetDecrypt(b1.header, b1.iv, b1.ciphertext);

    const a3 = await aliceSession.ratchetEncrypt('a3');

    // a3 is from the NEW chain, a2 from the old one — both must decrypt.
    expect(await bobSession.ratchetDecrypt(a3.header, a3.iv, a3.ciphertext)).toBe('a3');
    expect(await bobSession.ratchetDecrypt(a2.header, a2.iv, a2.ciphertext)).toBe('a2');
  });

  test('a replayed message cannot be decrypted twice', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const m = await aliceSession.ratchetEncrypt('once');
    expect(await bobSession.ratchetDecrypt(m.header, m.iv, m.ciphertext)).toBe('once');

    await expect(
      bobSession.ratchetDecrypt(m.header, m.iv, m.ciphertext)
    ).rejects.toThrow();
  });

  test('tampered ciphertext fails authentication', async () => {
    // AES-GCM must reject modification rather than return garbage.
    const { aliceSession, bobSession } = await establishPair();

    const m = await aliceSession.ratchetEncrypt('authentic');
    const bytes = atob(m.ciphertext).split('').map((c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(
      bobSession.ratchetDecrypt(m.header, m.iv, tampered)
    ).rejects.toThrow();
  });

  test('a third party with the ciphertext cannot decrypt it', async () => {
    const { aliceSession } = await establishPair();
    const { bobSession: strangerSession } = await establishPair();

    const m = await aliceSession.ratchetEncrypt('private');

    await expect(
      strangerSession.ratchetDecrypt(m.header, m.iv, m.ciphertext)
    ).rejects.toThrow();
  });

  test('encrypting before initialisation throws', async () => {
    const session = new RatchetSession();
    await expect(session.ratchetEncrypt('x')).rejects.toThrow(/not initialized/i);
  });

  test('destroy() zeroes key material in place', async () => {
    const { aliceSession } = await establishPair();
    // Keep references: the point is that the underlying buffers are wiped,
    // not merely dereferenced, so no key bytes linger in memory.
    const rootKey = aliceSession.rootKey;
    const sendChainKey = aliceSession.sendChainKey;

    aliceSession.destroy();

    expect(rootKey.every((b) => b === 0)).toBe(true);
    expect(sendChainKey.every((b) => b === 0)).toBe(true);
    expect(aliceSession.sendRatchetKeyPair).toBeNull();
    expect(aliceSession.skippedKeys.size).toBe(0);
    expect(aliceSession.initialized).toBe(false);
  });

  test('a destroyed session can no longer encrypt', async () => {
    const { aliceSession } = await establishPair();
    aliceSession.destroy();
    await expect(aliceSession.ratchetEncrypt('x')).rejects.toThrow();
  });

  test('round-trips unicode and long payloads', async () => {
    const { aliceSession, bobSession } = await establishPair();

    const payloads = ['🔐 émoji ünicode 中文', 'x'.repeat(50_000), '', JSON.stringify({ a: [1, 2, 3] })];
    for (const payload of payloads) {
      const m = await aliceSession.ratchetEncrypt(payload);
      expect(await bobSession.ratchetDecrypt(m.header, m.iv, m.ciphertext)).toBe(payload);
    }
  });
});
