import { describe, test, expect } from 'vitest';

import { x3dhInitiate, x3dhRespond, deriveInitialKeys } from '../../src/lib/crypto/x3dh.js';
import { createIdentity, corruptBase64 } from '../helpers/identity.js';

describe('X3DH', () => {
  test('initiator and responder derive the same shared secret', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();

    const { sharedSecret: aliceSecret, ephemeralPublicKey } = await x3dhInitiate(
      alice.identityKeyPair,
      bob.bundle
    );

    const { sharedSecret: bobSecret } = await x3dhRespond(
      bob.identityKeyPair,
      bob.signedPrekeyPair,
      bob.oneTimePrekeyPair,
      alice.identityKey,
      ephemeralPublicKey
    );

    expect(Array.from(aliceSecret)).toEqual(Array.from(bobSecret));
    expect(aliceSecret.length).toBeGreaterThanOrEqual(32);
  });

  test('works when no one-time prekey is available', async () => {
    // The server hands out a bundle with oneTimePrekey: null once a user's
    // prekeys are exhausted; the handshake must still complete.
    const alice = await createIdentity();
    const bob = await createIdentity();

    const { sharedSecret: aliceSecret, ephemeralPublicKey } = await x3dhInitiate(
      alice.identityKeyPair,
      { ...bob.bundle, oneTimePrekey: null }
    );

    const { sharedSecret: bobSecret } = await x3dhRespond(
      bob.identityKeyPair,
      bob.signedPrekeyPair,
      null,
      alice.identityKey,
      ephemeralPublicKey
    );

    expect(Array.from(aliceSecret)).toEqual(Array.from(bobSecret));
  });

  test('a bundle with a bad prekey signature is rejected', async () => {
    // This is the defence against a malicious server swapping in its own
    // signed prekey to mount a man-in-the-middle.
    const alice = await createIdentity();
    const bob = await createIdentity();

    await expect(
      x3dhInitiate(alice.identityKeyPair, {
        ...bob.bundle,
        prekeySig: corruptBase64(bob.bundle.prekeySig),
      })
    ).rejects.toThrow(/signature/i);
  });

  test('a bundle whose signed prekey was swapped is rejected', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();
    const mallory = await createIdentity();

    await expect(
      x3dhInitiate(alice.identityKeyPair, {
        ...bob.bundle,
        signedPrekey: mallory.bundle.signedPrekey,
      })
    ).rejects.toThrow(/signature/i);
  });

  test('two different peers never derive the same secret', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();
    const carol = await createIdentity();

    const a = await x3dhInitiate(alice.identityKeyPair, bob.bundle);
    const b = await x3dhInitiate(alice.identityKeyPair, carol.bundle);

    expect(Array.from(a.sharedSecret)).not.toEqual(Array.from(b.sharedSecret));
  });

  test('each handshake uses a fresh ephemeral key', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();

    const first = await x3dhInitiate(alice.identityKeyPair, bob.bundle);
    const second = await x3dhInitiate(alice.identityKeyPair, bob.bundle);

    expect(first.ephemeralPublicKey).not.toEqual(second.ephemeralPublicKey);
    expect(Array.from(first.sharedSecret)).not.toEqual(Array.from(second.sharedSecret));
  });

  test('an impostor cannot answer a handshake meant for someone else', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();
    const mallory = await createIdentity();

    const { sharedSecret: aliceSecret, ephemeralPublicKey } = await x3dhInitiate(
      alice.identityKeyPair,
      bob.bundle
    );

    const { sharedSecret: mallorySecret } = await x3dhRespond(
      mallory.identityKeyPair,
      mallory.signedPrekeyPair,
      mallory.oneTimePrekeyPair,
      alice.identityKey,
      ephemeralPublicKey
    );

    expect(Array.from(aliceSecret)).not.toEqual(Array.from(mallorySecret));
  });
});

describe('deriveInitialKeys', () => {
  test('splits the shared secret into distinct 32-byte root and chain keys', async () => {
    const alice = await createIdentity();
    const bob = await createIdentity();
    const { sharedSecret } = await x3dhInitiate(alice.identityKeyPair, bob.bundle);

    const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

    expect(rootKey.length).toBe(32);
    expect(chainKey.length).toBe(32);
    expect(Array.from(rootKey)).not.toEqual(Array.from(chainKey));
  });

  test('is deterministic for a given secret', async () => {
    const secret = new Uint8Array(32).fill(7);
    const a = await deriveInitialKeys(secret);
    const b = await deriveInitialKeys(secret);

    expect(Array.from(a.rootKey)).toEqual(Array.from(b.rootKey));
    expect(Array.from(a.chainKey)).toEqual(Array.from(b.chainKey));
  });

  test('both sides of a handshake derive identical initial keys', async () => {
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

    expect(Array.from(aliceKeys.rootKey)).toEqual(Array.from(bobKeys.rootKey));
    expect(Array.from(aliceKeys.chainKey)).toEqual(Array.from(bobKeys.chainKey));
  });
});
