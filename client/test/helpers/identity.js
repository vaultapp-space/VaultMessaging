// ============================================================
// Vault — Crypto Test Fixtures
// ============================================================
// Builds the same identity shape the real registration flow builds
// (see components/Auth.svelte), so protocol tests exercise the actual
// wire formats rather than a simplified stand-in.

import {
  generateKeyPair,
  generateSigningKeyPair,
  exportPublicKeyBase64,
  signData,
} from '../../src/lib/crypto/keys.js';
import { fromBase64, toBase64 } from '../../src/lib/crypto/utils.js';

// A full local identity: ECDH + ECDSA identity keys, a signed prekey, and
// one-time prekeys — everything needed to both initiate and answer X3DH.
export async function createIdentity() {
  const ecdh = await generateKeyPair();
  const ecdsa = await generateSigningKeyPair();
  const signedPrekeyPair = await generateKeyPair();
  const oneTimePrekeyPair = await generateKeyPair();

  const ecdhPub = await exportPublicKeyBase64(ecdh.publicKey);
  const ecdsaPub = await exportPublicKeyBase64(ecdsa.publicKey);
  const signedPrekey = await exportPublicKeyBase64(signedPrekeyPair.publicKey);
  const oneTimePrekey = await exportPublicKeyBase64(oneTimePrekeyPair.publicKey);

  // The signed prekey is signed over its RAW bytes, not the base64 text, and
  // the signature travels base64-encoded (see Auth.svelte's prekeySigBase64).
  const prekeySig = toBase64(await signData(ecdsa.privateKey, fromBase64(signedPrekey)));

  const identityKey = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));

  return {
    identityKeyPair: { ecdh, ecdsa },
    signedPrekeyPair,
    oneTimePrekeyPair,
    identityKey,
    // What the server hands out from GET /api/keys/bundle/:username
    bundle: { identityKey, signedPrekey, prekeySig, oneTimePrekey },
  };
}

export function corruptBase64(b64) {
  const bytes = fromBase64(b64);
  bytes[0] ^= 0xff;
  return btoa(String.fromCharCode(...bytes));
}
