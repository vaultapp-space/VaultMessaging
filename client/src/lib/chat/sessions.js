// ============================================================
// Vault — Session Establishment
// ============================================================
// X3DH handshake and Double Ratchet session setup, lifted out of
// ChatView.svelte.
//
// This is deliberately the first thing extracted from that 2000-line
// component. It is the code path that decides whether two users can talk at
// all: it performs the X3DH initiation, seeds the ratchet, and packages the
// header that tells the recipient which of the two decryption paths to take.
// Buried inside a component it could only be exercised by driving the UI;
// here it is an ordinary module that the send path — and, in the next phase,
// the cloud/secret fork — can call directly.
//
// It is also the most dangerous code in the client to get wrong: a mistake
// here does not throw, it silently produces messages the peer cannot read.

import { get } from 'svelte/store';

import { identityKeyPair, ratchetSessions } from '../stores/session.js';
import { fetchKeyBundle } from '../api/http.js';
import { x3dhInitiate, deriveInitialKeys } from '../crypto/x3dh.js';
import { RatchetSession } from '../crypto/ratchet.js';
import { exportPublicKeyBase64 } from '../crypto/keys.js';

/**
 * Returns the ratchet session for a peer, performing an X3DH handshake first
 * if none exists yet.
 *
 * When a new session is created the caller *must* include the returned
 * `x3dhParams` in the message header — without them the recipient has no way
 * to derive the same root key and every message in the conversation fails to
 * decrypt.
 *
 * @returns {Promise<{ratchet: RatchetSession, isNew: boolean, x3dhParams?: object}>}
 */
export async function getOrCreateRatchetForUser(userId, username) {
  const sessions = get(ratchetSessions);

  if (sessions.has(userId)) {
    return { ratchet: sessions.get(userId), isNew: false };
  }

  const _ikp = get(identityKeyPair);
  if (!_ikp) {
    throw new Error('No identity key pair available');
  }

  const bundle = await fetchKeyBundle(username);
  const { sharedSecret, ephemeralPublicKey } = await x3dhInitiate(_ikp, bundle);
  const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

  const ratchet = new RatchetSession();
  await ratchet.initAsSender(rootKey, chainKey, bundle.signedPrekey, bundle.identityKey);

  ratchetSessions.update((map) => {
    map.set(userId, ratchet);
    return new Map(map);
  });

  const ecdhPub = await exportPublicKeyBase64(_ikp.ecdh.publicKey);
  const ecdsaPub = await exportPublicKeyBase64(_ikp.ecdsa.publicKey);
  const ownIdentityPub = btoa(JSON.stringify({ ecdh: ecdhPub, ecdsa: ecdsaPub }));

  return {
    ratchet,
    isNew: true,
    x3dhParams: {
      ik: ownIdentityPub,
      ek: ephemeralPublicKey,
      opk: bundle.oneTimePrekey,
    },
  };
}

/**
 * Encrypts a WebRTC signalling payload to a peer over the same ratchet used
 * for messages, so call setup is no less protected than the conversation.
 *
 * The username is passed in rather than read from component state: this is
 * called both from an open conversation and from an incoming-call prompt,
 * where no conversation is open at all.
 */
export async function encryptSignalingPayload(peerId, payloadObj, username) {
  const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser(peerId, username);
  const textToEncrypt = JSON.stringify(payloadObj);
  const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(textToEncrypt);

  const packagedCiphertext = btoa(JSON.stringify({
    bob: { ct: ciphertext, iv },
  }));

  // The header tells the recipient which decryption path to take. 'x3dh'
  // carries the handshake material needed to establish the session; 'ratchet'
  // means one already exists and only the new DH public key is required.
  const packagedEphemeralHeader = JSON.stringify(isNew ? {
    type: 'x3dh',
    ik: x3dhParams.ik,
    ek: x3dhParams.ek,
    opk: x3dhParams.opk,
    rk: header.publicKey,
  } : {
    type: 'ratchet',
    rk: header.publicKey,
  });

  return {
    ciphertext: packagedCiphertext,
    ephemeralKey: packagedEphemeralHeader,
    messageNumber: header.messageNumber,
    previousChain: header.previousChainLength,
    iv,
  };
}
