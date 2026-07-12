// ============================================================
// Vault — Simplified Double Ratchet
// All ratchet state lives ONLY in volatile JS memory (Section 0)
// ============================================================

import {
  generateKeyPair,
  exportPublicKeyBase64,
  importPublicKey,
  deriveSharedBits,
  deriveAESKey,
  hmacSHA256,
  encrypt,
  decrypt,
} from './keys.js';
import { arraysEqual, fromBase64, toBase64 } from './utils.js';

const CK_MSG  = new Uint8Array([0x01]); // Chain key → message key constant
const CK_NEXT = new Uint8Array([0x02]); // Chain key → next chain key constant

/**
 * Double Ratchet session — all state in volatile JS memory.
 * Destroyed on tab close, logout, or session expiry.
 */
export class RatchetSession {
  constructor() {
    this.rootKey = null;            // Uint8Array(32)
    this.sendChainKey = null;       // Uint8Array(32)
    this.recvChainKey = null;       // Uint8Array(32)
    this.sendRatchetKeyPair = null; // CryptoKeyPair
    this.recvRatchetPubKey = null;  // base64 string of peer's current DH public
    this.sendCount = 0;
    this.recvCount = 0;
    this.prevSendCount = 0;
    this.skippedKeys = new Map();   // `${pubkey}:${n}` → Uint8Array message key
    this.initialized = false;
    this.peerIdentityKey = null;    // base64 string of peer's identity key
  }

  /**
   * Initialize as SENDER (the one initiating the conversation).
   * Called after X3DH completes.
   * @param {Uint8Array} rootKey - from X3DH derived keys
   * @param {Uint8Array} chainKey - from X3DH derived keys
   * @param {string} peerPublicKeyBase64 - peer's signed prekey (initial ratchet key)
   * @param {string|null} peerIdentityKey - peer's identity key base64 string
   */
  async initAsSender(rootKey, chainKey, peerPublicKeyBase64, peerIdentityKey = null) {
    this.rootKey = rootKey;
    this.recvRatchetPubKey = peerPublicKeyBase64;
    this.peerIdentityKey = peerIdentityKey;

    // Generate our first sending ratchet key
    this.sendRatchetKeyPair = await generateKeyPair();

    // Perform DH ratchet step to derive sending chain key
    const peerPub = await importPublicKey(peerPublicKeyBase64);
    const dhOut = await deriveSharedBits(this.sendRatchetKeyPair.privateKey, peerPub);

    // KDF to get new root key and sending chain key
    const { newRootKey, newChainKey } = await this._kdfRatchet(rootKey, dhOut);
    this.rootKey = newRootKey;
    this.sendChainKey = newChainKey;

    this.initialized = true;
  }

  /**
   * Initialize as RECEIVER (the one receiving the first message).
   * @param {Uint8Array} rootKey
   * @param {Uint8Array} chainKey
   * @param {CryptoKeyPair} ourSignedPrekeyPair - our signed prekey (the initial ratchet key)
   * @param {string|null} peerIdentityKey - peer's identity key base64 string
   */
  async initAsReceiver(rootKey, chainKey, ourSignedPrekeyPair, peerIdentityKey = null) {
    this.rootKey = rootKey;
    this.recvChainKey = chainKey;
    this.sendRatchetKeyPair = ourSignedPrekeyPair;
    this.peerIdentityKey = peerIdentityKey;
    this.initialized = true;
  }

  /**
   * Encrypt a message using the sending chain.
   * @param {string} plaintext
   * @returns {Promise<{header: object, iv: string, ciphertext: string}>}
   */
  async ratchetEncrypt(plaintext) {
    if (!this.sendChainKey) {
      throw new Error('Sending chain not initialized');
    }

    // Derive message key from chain key
    const msgKey = await hmacSHA256(this.sendChainKey, CK_MSG);
    // Advance chain key
    this.sendChainKey = await hmacSHA256(this.sendChainKey, CK_NEXT);

    // Encrypt with AES-GCM using derived message key
    const aesKey = await deriveAESKey(msgKey, undefined, 'vault-msg-encrypt');
    const { iv, ciphertext } = await encrypt(aesKey, plaintext);

    const header = {
      publicKey: await exportPublicKeyBase64(this.sendRatchetKeyPair.publicKey),
      messageNumber: this.sendCount,
      previousChainLength: this.prevSendCount,
    };

    this.sendCount++;
    return { header, iv, ciphertext };
  }

  /**
   * Decrypt a message, performing a DH ratchet step if needed.
   * @param {object} header - { publicKey, messageNumber, previousChainLength }
   * @param {string} iv - base64 IV
   * @param {string} ciphertext - base64 ciphertext
   * @returns {Promise<string>} - decrypted plaintext
   */
  async ratchetDecrypt(header, iv, ciphertext) {
    // Check if this is from a new ratchet key (DH ratchet step needed)
    if (header.publicKey !== this.recvRatchetPubKey) {
      // Store any skipped keys from current chain
      await this._skipKeys(this.recvRatchetPubKey, this.recvCount, header.previousChainLength);

      // Perform DH ratchet step
      await this._dhRatchetStep(header.publicKey);
    }

    // Check for skipped key
    const skippedId = `${header.publicKey}:${header.messageNumber}`;
    if (this.skippedKeys.has(skippedId)) {
      const msgKey = this.skippedKeys.get(skippedId);
      this.skippedKeys.delete(skippedId);
      const aesKey = await deriveAESKey(msgKey, undefined, 'vault-msg-encrypt');
      return await decrypt(aesKey, iv, ciphertext);
    }

    // Skip any missing messages
    await this._skipKeys(header.publicKey, this.recvCount, header.messageNumber);

    // Derive message key
    const msgKey = await hmacSHA256(this.recvChainKey, CK_MSG);
    this.recvChainKey = await hmacSHA256(this.recvChainKey, CK_NEXT);

    const aesKey = await deriveAESKey(msgKey, undefined, 'vault-msg-encrypt');
    const plaintext = await decrypt(aesKey, iv, ciphertext);

    this.recvCount++;
    return plaintext;
  }

  /**
   * Perform a DH ratchet step when receiving a new public key.
   */
  async _dhRatchetStep(newPeerPublicKeyBase64) {
    this.prevSendCount = this.sendCount;
    this.sendCount = 0;
    this.recvCount = 0;
    this.recvRatchetPubKey = newPeerPublicKeyBase64;

    const peerPub = await importPublicKey(newPeerPublicKeyBase64);

    // Derive receiving chain
    const dhRecv = await deriveSharedBits(this.sendRatchetKeyPair.privateKey, peerPub);
    const recv = await this._kdfRatchet(this.rootKey, dhRecv);
    this.rootKey = recv.newRootKey;
    this.recvChainKey = recv.newChainKey;

    // Generate new sending key pair
    this.sendRatchetKeyPair = await generateKeyPair();

    // Derive sending chain
    const dhSend = await deriveSharedBits(this.sendRatchetKeyPair.privateKey, peerPub);
    const send = await this._kdfRatchet(this.rootKey, dhSend);
    this.rootKey = send.newRootKey;
    this.sendChainKey = send.newChainKey;
  }

  /**
   * KDF ratchet: derive new root key and chain key from root key + DH output.
   */
  async _kdfRatchet(rootKey, dhOutput) {
    const hkdfKey = await crypto.subtle.importKey('raw', dhOutput, 'HKDF', false, ['deriveBits']);
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: rootKey,
          info: new TextEncoder().encode('vault-ratchet-kdf'),
        },
        hkdfKey,
        512
      )
    );
    return {
      newRootKey: derived.slice(0, 32),
      newChainKey: derived.slice(32, 64),
    };
  }

  /**
   * Store skipped message keys for out-of-order delivery.
   */
  async _skipKeys(pubKey, start, until) {
    if (!this.recvChainKey || !pubKey) return;
    const maxSkip = 100; // Safety limit
    for (let i = start; i < until && i < start + maxSkip; i++) {
      const msgKey = await hmacSHA256(this.recvChainKey, CK_MSG);
      this.recvChainKey = await hmacSHA256(this.recvChainKey, CK_NEXT);
      this.skippedKeys.set(`${pubKey}:${i}`, msgKey);
    }
  }

  /**
   * Wipe all key material from memory.
   * Called on logout / tab close / session expiry.
   */
  destroy() {
    if (this.rootKey) this.rootKey.fill(0);
    if (this.sendChainKey) this.sendChainKey.fill(0);
    if (this.recvChainKey) this.recvChainKey.fill(0);
    this.sendRatchetKeyPair = null;
    this.recvRatchetPubKey = null;
    for (const key of this.skippedKeys.values()) {
      if (key instanceof Uint8Array) key.fill(0);
    }
    this.skippedKeys.clear();
    this.initialized = false;
  }
}
