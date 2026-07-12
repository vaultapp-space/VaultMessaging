// ============================================================
// Vault — Simplified X3DH Key Exchange
// Adapted for zero client persistence (Section 0)
// ============================================================

import {
  generateKeyPair,
  exportPublicKeyBase64,
  importPublicKey,
  deriveSharedBits,
  deriveAESKey,
} from './keys.js';
import { concat, fromBase64 } from './utils.js';

/**
 * Perform X3DH key agreement as the initiator (Alice).
 * 
 * @param {CryptoKeyPair} identityKeyPair - Our identity key pair
 * @param {object} peerBundle - Peer's prekey bundle from server
 * @param {string} peerBundle.identityKey - base64 peer identity public key
 * @param {string} peerBundle.signedPrekey - base64 peer signed prekey
 * @param {string|null} peerBundle.oneTimePrekey - base64 peer one-time prekey (may be null)
 * @returns {Promise<{sharedSecret: Uint8Array, ephemeralPublicKey: string}>}
 */
export async function x3dhInitiate(identityKeyPair, peerBundle) {
  // Import peer's public keys
  const parsedPeerIk = JSON.parse(atob(peerBundle.identityKey));
  const peerIdentityKey = await importPublicKey(parsedPeerIk.ecdh);
  const peerSignedPrekey = await importPublicKey(peerBundle.signedPrekey);

  // Verify peer's signed prekey signature
  const peerEcdsaKey = await crypto.subtle.importKey(
    'raw',
    fromBase64(parsedPeerIk.ecdsa),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  const spkRaw = fromBase64(peerBundle.signedPrekey);
  const sigBytes = fromBase64(peerBundle.prekeySig);
  const spkVerified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    peerEcdsaKey,
    sigBytes,
    spkRaw
  );
  if (!spkVerified) {
    throw new Error('Peer signed prekey signature verification failed');
  }

  // Generate ephemeral key pair
  const ephemeralKeyPair = await generateKeyPair();

  // Perform DH operations:
  // DH1 = DH(IK_a, SPK_b)
  const dh1 = await deriveSharedBits(identityKeyPair.ecdh.privateKey, peerSignedPrekey, 'x3dh-dh1');
  // DH2 = DH(EK_a, IK_b)
  const dh2 = await deriveSharedBits(ephemeralKeyPair.privateKey, peerIdentityKey, 'x3dh-dh2');
  // DH3 = DH(EK_a, SPK_b)
  const dh3 = await deriveSharedBits(ephemeralKeyPair.privateKey, peerSignedPrekey, 'x3dh-dh3');

  let combined;
  if (peerBundle.oneTimePrekey) {
    // DH4 = DH(EK_a, OPK_b)
    const peerOPK = await importPublicKey(peerBundle.oneTimePrekey);
    const dh4 = await deriveSharedBits(ephemeralKeyPair.privateKey, peerOPK, 'x3dh-dh4');
    combined = concat(dh1, dh2, dh3, dh4);
  } else {
    combined = concat(dh1, dh2, dh3);
  }

  // Derive shared secret via HKDF instead of raw slice
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    combined,
    'HKDF',
    false,
    ['deriveBits']
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('vault-x3dh-shared'),
      },
      hkdfKey,
      256 // 32 bytes
    )
  );

  const ephemeralPublicKey = await exportPublicKeyBase64(ephemeralKeyPair.publicKey);

  return {
    sharedSecret,
    ephemeralKeyPair,
    ephemeralPublicKey,
  };
}

/**
 * Perform X3DH key agreement as the responder (Bob).
 * 
 * @param {CryptoKeyPair} identityKeyPair - Our identity key pair
 * @param {CryptoKeyPair} signedPrekeyPair - Our signed prekey pair
 * @param {CryptoKeyPair|null} oneTimePrekeyPair - Our one-time prekey pair (if consumed)
 * @param {string} peerIdentityKeyBase64 - Peer's identity public key (base64)
 * @param {string} peerEphemeralKeyBase64 - Peer's ephemeral public key (base64)
 * @returns {Promise<{sharedSecret: Uint8Array}>}
 */
export async function x3dhRespond(
  identityKeyPair,
  signedPrekeyPair,
  oneTimePrekeyPair,
  peerIdentityKeyBase64,
  peerEphemeralKeyBase64
) {
  const parsedPeerIk = JSON.parse(atob(peerIdentityKeyBase64));
  const peerIdentityKey = await importPublicKey(parsedPeerIk.ecdh);
  const peerEphemeralKey = await importPublicKey(peerEphemeralKeyBase64);

  // Mirror DH operations (reversed roles):
  // DH1 = DH(SPK_b, IK_a)
  const dh1 = await deriveSharedBits(signedPrekeyPair.privateKey, peerIdentityKey, 'x3dh-dh1');
  // DH2 = DH(IK_b, EK_a)
  const dh2 = await deriveSharedBits(identityKeyPair.ecdh.privateKey, peerEphemeralKey, 'x3dh-dh2');
  // DH3 = DH(SPK_b, EK_a)
  const dh3 = await deriveSharedBits(signedPrekeyPair.privateKey, peerEphemeralKey, 'x3dh-dh3');

  let combined;
  if (oneTimePrekeyPair) {
    // DH4 = DH(OPK_b, EK_a)
    const dh4 = await deriveSharedBits(oneTimePrekeyPair.privateKey, peerEphemeralKey, 'x3dh-dh4');
    combined = concat(dh1, dh2, dh3, dh4);
  } else {
    combined = concat(dh1, dh2, dh3);
  }

  // Derive shared secret via HKDF instead of raw slice
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    combined,
    'HKDF',
    false,
    ['deriveBits']
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('vault-x3dh-shared'),
      },
      hkdfKey,
      256 // 32 bytes
    )
  );

  return { sharedSecret };
}

/**
 * Derive the initial root key + chain keys from X3DH shared secret.
 * Used to initialize the Double Ratchet.
 * @param {Uint8Array} sharedSecret
 * @returns {Promise<{rootKey: Uint8Array, chainKey: Uint8Array}>}
 */
export async function deriveInitialKeys(sharedSecret) {
  // Use HKDF to split shared secret into root key and chain key
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('vault-x3dh-init'),
      },
      hkdfKey,
      512 // 64 bytes = 32 root + 32 chain
    )
  );

  return {
    rootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}
