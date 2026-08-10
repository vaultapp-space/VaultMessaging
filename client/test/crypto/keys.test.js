import { describe, test, expect } from 'vitest';

import {
  generateKeyPair,
  generateExportableKeyPair,
  generateSigningKeyPair,
  exportPublicKeyBase64,
  importPublicKey,
  deriveSharedBits,
  deriveAESKey,
  encrypt,
  decrypt,
  hmacSHA256,
  signData,
  generateOneTimePrekeys,
  deriveMasterKeyBits,
  deriveServerAuthSecret,
  encryptFile,
  decryptFile,
  encryptChunk,
  decryptChunk,
  encryptIdentityVault,
  decryptIdentityVault,
} from '../../src/lib/crypto/keys.js';
import { toBase64 } from '../../src/lib/crypto/utils.js';

const SALT = toBase64(new Uint8Array(16).fill(3));

describe('ECDH agreement', () => {
  test('both parties derive the same bits', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const ab = await deriveSharedBits(a.privateKey, b.publicKey);
    const ba = await deriveSharedBits(b.privateKey, a.publicKey);

    expect(Array.from(ab)).toEqual(Array.from(ba));
  });

  test('the info argument provides domain separation', async () => {
    // The same key pair in two contexts must yield unrelated secrets. This
    // used to be the opposite assertion, pinning a bug: `info` was accepted,
    // documented, and ignored.
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const one = await deriveSharedBits(a.privateKey, b.publicKey, 'context-one');
    const two = await deriveSharedBits(a.privateKey, b.publicKey, 'context-two');

    expect(Array.from(one)).not.toEqual(Array.from(two));
  });

  test('both sides still agree when they use the same context', async () => {
    // Domain separation must not break agreement itself.
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const fromA = await deriveSharedBits(a.privateKey, b.publicKey, 'x3dh-dh1');
    const fromB = await deriveSharedBits(b.privateKey, a.publicKey, 'x3dh-dh1');

    expect(Array.from(fromA)).toEqual(Array.from(fromB));
  });

  test('the default context is stable', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const implicit = await deriveSharedBits(a.privateKey, b.publicKey);
    const explicit = await deriveSharedBits(a.privateKey, b.publicKey, 'vault-e2ee');

    expect(Array.from(implicit)).toEqual(Array.from(explicit));
  });

  test('output is 32 bytes and not the raw ECDH result', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const derived = await deriveSharedBits(a.privateKey, b.publicKey, 'ctx');
    const raw = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: b.publicKey }, a.privateKey, 256
    ));

    expect(derived.length).toBe(32);
    expect(Array.from(derived)).not.toEqual(Array.from(raw), 'HKDF is actually applied');
  });

  test('a public key survives an export/import round trip', async () => {
    const pair = await generateKeyPair();
    const other = await generateKeyPair();

    const b64 = await exportPublicKeyBase64(pair.publicKey);
    const reimported = await importPublicKey(b64);

    const direct = await deriveSharedBits(other.privateKey, pair.publicKey);
    const viaRoundTrip = await deriveSharedBits(other.privateKey, reimported);

    expect(Array.from(direct)).toEqual(Array.from(viaRoundTrip));
  });
});

describe('AES-GCM encrypt/decrypt', () => {
  test('round-trips a string', async () => {
    const key = await deriveAESKey(new Uint8Array(32).fill(1));
    const { iv, ciphertext } = await encrypt(key, 'hello');

    expect(await decrypt(key, iv, ciphertext)).toBe('hello');
  });

  test('the same plaintext encrypts differently each time', async () => {
    const key = await deriveAESKey(new Uint8Array(32).fill(1));
    const a = await encrypt(key, 'same');
    const b = await encrypt(key, 'same');

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  test('the wrong key fails', async () => {
    const key = await deriveAESKey(new Uint8Array(32).fill(1));
    const wrong = await deriveAESKey(new Uint8Array(32).fill(2));
    const { iv, ciphertext } = await encrypt(key, 'secret');

    await expect(decrypt(wrong, iv, ciphertext)).rejects.toThrow();
  });

  test('the wrong IV fails', async () => {
    const key = await deriveAESKey(new Uint8Array(32).fill(1));
    const { ciphertext } = await encrypt(key, 'secret');
    const wrongIv = toBase64(new Uint8Array(12).fill(9));

    await expect(decrypt(key, wrongIv, ciphertext)).rejects.toThrow();
  });

  test('deriveAESKey is deterministic for the same inputs', async () => {
    const ikm = new Uint8Array(32).fill(5);
    const k1 = await deriveAESKey(ikm, undefined, 'ctx');
    const k2 = await deriveAESKey(ikm, undefined, 'ctx');

    const { iv, ciphertext } = await encrypt(k1, 'cross-key');
    expect(await decrypt(k2, iv, ciphertext)).toBe('cross-key');
  });

  test('a different info string produces a non-interchangeable key', async () => {
    const ikm = new Uint8Array(32).fill(5);
    const k1 = await deriveAESKey(ikm, undefined, 'ctx-a');
    const k2 = await deriveAESKey(ikm, undefined, 'ctx-b');

    const { iv, ciphertext } = await encrypt(k1, 'x');
    await expect(decrypt(k2, iv, ciphertext)).rejects.toThrow();
  });
});

describe('hmacSHA256', () => {
  test('is deterministic and 32 bytes', async () => {
    const key = new Uint8Array(32).fill(4);
    const a = await hmacSHA256(key, new Uint8Array([1]));
    const b = await hmacSHA256(key, new Uint8Array([1]));

    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('different data yields a different tag', async () => {
    const key = new Uint8Array(32).fill(4);
    const a = await hmacSHA256(key, new Uint8Array([1]));
    const b = await hmacSHA256(key, new Uint8Array([2]));

    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('signatures', () => {
  test('a signature verifies and a tampered one does not', async () => {
    const pair = await generateSigningKeyPair();
    const data = new TextEncoder().encode('sign me');
    const sig = await signData(pair.privateKey, data);

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, data
    );
    expect(ok).toBe(true);

    const tampered = new TextEncoder().encode('sign me!');
    const bad = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, tampered
    );
    expect(bad).toBe(false);
  });
});

describe('one-time prekeys', () => {
  test('generates the requested count with unique public keys', async () => {
    const { publicKeys, keyPairs } = await generateOneTimePrekeys(5);

    expect(publicKeys.length).toBe(5);
    expect(keyPairs.length).toBe(5);
    expect(new Set(publicKeys).size).toBe(5, 'every prekey must be distinct');
  });

  test('each returned public key matches its key pair', async () => {
    const { publicKeys, keyPairs } = await generateOneTimePrekeys(3);

    for (let i = 0; i < 3; i += 1) {
      expect(await exportPublicKeyBase64(keyPairs[i].publicKey)).toBe(publicKeys[i]);
    }
  });
});

describe('password-derived keys', () => {
  test('the master key is deterministic for a password and salt', async () => {
    const a = await deriveMasterKeyBits('correct horse', SALT);
    const b = await deriveMasterKeyBits('correct horse', SALT);
    expect(toBase64(new Uint8Array(a))).toBe(toBase64(new Uint8Array(b)));
  });

  test('a different password gives a different master key', async () => {
    const a = await deriveMasterKeyBits('password-one', SALT);
    const b = await deriveMasterKeyBits('password-two', SALT);
    expect(toBase64(new Uint8Array(a))).not.toBe(toBase64(new Uint8Array(b)));
  });

  test('a different salt gives a different master key', async () => {
    const other = toBase64(new Uint8Array(16).fill(9));
    const a = await deriveMasterKeyBits('same-password', SALT);
    const b = await deriveMasterKeyBits('same-password', other);
    expect(toBase64(new Uint8Array(a))).not.toBe(toBase64(new Uint8Array(b)));
  });

  test('the server auth secret is not the master key itself', async () => {
    // The server must never receive anything from which the master key,
    // and therefore the vault, can be reconstructed.
    const master = await deriveMasterKeyBits('a-password', SALT);
    const authSecret = await deriveServerAuthSecret(master);

    const masterB64 = toBase64(new Uint8Array(master));
    const authB64 = typeof authSecret === 'string' ? authSecret : toBase64(new Uint8Array(authSecret));

    expect(authB64).not.toBe(masterB64);
    expect(masterB64).not.toContain(authB64);
  });
});

describe('file encryption', () => {
  test('round-trips file bytes', async () => {
    const original = new TextEncoder().encode('file contents here');
    const { ciphertextBase64, keyBase64, ivBase64 } = await encryptFile(original.buffer);

    const out = await decryptFile(ciphertextBase64, keyBase64, ivBase64);
    expect(new TextDecoder().decode(new Uint8Array(out))).toBe('file contents here');
  });

  test('the wrong key fails', async () => {
    const original = new TextEncoder().encode('file contents');
    const a = await encryptFile(original.buffer);
    const b = await encryptFile(original.buffer);

    await expect(decryptFile(a.ciphertextBase64, b.keyBase64, a.ivBase64)).rejects.toThrow();
  });

  test('each file gets a distinct key', async () => {
    const bytes = new TextEncoder().encode('same content');
    const a = await encryptFile(bytes.buffer);
    const b = await encryptFile(bytes.buffer);

    expect(a.keyBase64).not.toBe(b.keyBase64);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });
});

describe('chunked encryption', () => {
  test('round-trips each chunk at its own index', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const baseIv = crypto.getRandomValues(new Uint8Array(12));

    for (let i = 0; i < 4; i += 1) {
      const data = new TextEncoder().encode(`chunk ${i}`);
      const enc = await encryptChunk(key, data.buffer, i, baseIv);
      const dec = await decryptChunk(key, enc, i, baseIv);
      expect(new TextDecoder().decode(new Uint8Array(dec))).toBe(`chunk ${i}`);
    }
  });

  test('a chunk cannot be decrypted at the wrong index', async () => {
    // The chunk index is folded into the IV, so reordering chunks is detected.
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const baseIv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('chunk zero');

    const enc = await encryptChunk(key, data.buffer, 0, baseIv);
    await expect(decryptChunk(key, enc, 1, baseIv)).rejects.toThrow();
  });

  test('the same chunk at different indices produces different ciphertext', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    const baseIv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('identical');

    const a = await encryptChunk(key, data.buffer, 0, baseIv);
    const b = await encryptChunk(key, data.buffer, 1, baseIv);

    expect(toBase64(a)).not.toBe(toBase64(b));
  });
});

describe('identity vault', () => {
  async function makeVaultObject() {
    return {
      // The vault exports private keys to JWK, so these must be the
      // exportable variant — generateKeyPair() deliberately is not.
      identityKeyPair: {
        ecdh: await generateExportableKeyPair(),
        ecdsa: await generateSigningKeyPair(),
      },
      signedPrekeyPair: await generateExportableKeyPair(),
    };
  }

  test('round-trips with the right passphrase', async () => {
    const vault = await makeVaultObject();
    const encrypted = await encryptIdentityVault(vault, 'a-strong-passphrase');
    const restored = await decryptIdentityVault(encrypted, 'a-strong-passphrase');

    // The restored identity must be usable for real agreement, which is a
    // stronger check than comparing serialised fields.
    const peer = await generateKeyPair();
    const before = await deriveSharedBits(vault.identityKeyPair.ecdh.privateKey, peer.publicKey);
    const after = await deriveSharedBits(restored.identityKeyPair.ecdh.privateKey, peer.publicKey);

    expect(Array.from(after)).toEqual(Array.from(before));
  });

  test('fails with the wrong passphrase', async () => {
    const vault = await makeVaultObject();
    const encrypted = await encryptIdentityVault(vault, 'right-passphrase');

    await expect(decryptIdentityVault(encrypted, 'wrong-passphrase')).rejects.toThrow();
  });

  test('the encrypted blob leaks no private key material', async () => {
    const vault = await makeVaultObject();
    const encrypted = await encryptIdentityVault(vault, 'passphrase');

    const privateJwk = await crypto.subtle.exportKey('jwk', vault.identityKeyPair.ecdh.privateKey);
    const blob = typeof encrypted === 'string' ? encrypted : JSON.stringify(encrypted);

    expect(blob).not.toContain(privateJwk.d);
    expect(blob).not.toContain('passphrase');
  });
});

