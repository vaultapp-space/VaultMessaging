// ============================================================
// Vault — Signal Sender Keys Group protocol
// Optimizes group messaging from O(N) to O(1) client overhead.
// ============================================================

import {
  generateKeyPair,
  exportPublicKeyBase64,
  importPublicKey,
  deriveAESKey,
  hmacSHA256,
  encrypt,
  decrypt,
  signData
} from './keys.js';
import { toBase64 } from './utils.js';

const CK_MSG  = new Uint8Array([0x03]); // Group Chain key → message key constant
const CK_NEXT = new Uint8Array([0x04]); // Group Chain key → next chain key constant

export class SenderKeySession {
  constructor(senderId, groupId) {
    this.senderId = senderId;
    this.groupId = groupId;
    this.chainKey = null;       // Uint8Array(32)
    this.messageNumber = 0;
    this.signingPubKey = null;   // ECDSA public key (base64 or CryptoKey)
    this.signingPrivKey = null;  // ECDSA private key (CryptoKey) - owned by sender only
    this.skippedKeys = new Map(); // messageNumber → messageKey
  }

  /** Initialize a fresh Sender Key for our own outbound messages. */
  async initSelf() {
    this.chainKey = crypto.getRandomValues(new Uint8Array(32));
    
    // Generate ECDSA signing key pair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    this.signingPrivKey = keyPair.privateKey;
    this.signingPubKey = keyPair.publicKey;
    this.messageNumber = 0;
  }

  /**
   * Export the Sender Key state for secure distribution to group members.
   * @returns {Promise<object>} - Serializable package to send over secure pairwise channels
   */
  async exportDistributionPackage() {
    const pubKeyBase64 = await exportPublicKeyBase64(this.signingPubKey);
    const chainKeyBase64 = toBase64(this.chainKey);

    return {
      senderId: this.senderId,
      groupId: this.groupId,
      chainKey: chainKeyBase64,
      signingPubKey: pubKeyBase64,
      messageNumber: this.messageNumber
    };
  }

  /** Initialize or update a peer's Sender Key using their distributed package. */
  async importDistributionPackage(pack) {
    this.chainKey = new Uint8Array(atob(pack.chainKey).split('').map(c => c.charCodeAt(0)));
    this.signingPubKey = await importPublicKey(pack.signingPubKey, { name: 'ECDSA', namedCurve: 'P-256' }, ['verify']);
    this.messageNumber = pack.messageNumber;
  }

  /**
   * Encrypt group message payload.
   * @param {string} plaintext
   * @returns {Promise<object>} - Packet to send to the server
   */
  async encrypt(plaintext) {
    if (!this.chainKey || !this.signingPrivKey) {
      throw new Error('SenderKeySession not initialized for self encryption.');
    }

    // Derive message key
    const msgKey = await hmacSHA256(this.chainKey, CK_MSG);
    // Advance chain key
    this.chainKey = await hmacSHA256(this.chainKey, CK_NEXT);

    // Encrypt
    const aesKey = await deriveAESKey(msgKey, undefined, 'vault-group-encrypt');
    const { iv, ciphertext } = await encrypt(aesKey, plaintext);

    // Sign the ciphertext using ECDSA
    const encoder = new TextEncoder();
    const dataToSign = encoder.encode(ciphertext);
    const signatureBytes = await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      this.signingPrivKey,
      dataToSign
    );
    const signature = toBase64(new Uint8Array(signatureBytes));

    const packet = {
      senderId: this.senderId,
      groupId: this.groupId,
      messageNumber: this.messageNumber,
      iv,
      ciphertext,
      signature
    };

    this.messageNumber++;
    return packet;
  }

  /**
   * Decrypt a received group message.
   * @param {object} packet - { messageNumber, iv, ciphertext, signature }
   * @returns {Promise<string>} - Decrypted plaintext
   */
  async decrypt(packet) {
    if (!this.chainKey || !this.signingPubKey) {
      throw new Error('SenderKeySession not initialized for decryption.');
    }

    // 1. Verify ECDSA signature first!
    const encoder = new TextEncoder();
    const dataToVerify = encoder.encode(packet.ciphertext);
    const rawSig = new Uint8Array(atob(packet.signature).split('').map(c => c.charCodeAt(0)));
    
    const isValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      this.signingPubKey,
      rawSig,
      dataToVerify
    );

    if (!isValid) {
      throw new Error('[Security] Invalid group message signature! Tampering detected.');
    }

    // 2. Catch up missing chain keys if out-of-order
    if (packet.messageNumber < this.messageNumber) {
      // Check skipped keys
      if (this.skippedKeys.has(packet.messageNumber)) {
        const msgKey = this.skippedKeys.get(packet.messageNumber);
        this.skippedKeys.delete(packet.messageNumber);
        const aesKey = await deriveAESKey(msgKey, undefined, 'vault-group-encrypt');
        return await decrypt(aesKey, packet.iv, packet.ciphertext);
      }
      throw new Error('Message key already consumed or expired');
    }

    while (this.messageNumber < packet.messageNumber) {
      const skippedMsgKey = await hmacSHA256(this.chainKey, CK_MSG);
      this.skippedKeys.set(this.messageNumber, skippedMsgKey);
      this.chainKey = await hmacSHA256(this.chainKey, CK_NEXT);
      this.messageNumber++;
    }

    // 3. Derive key for this message number
    const msgKey = await hmacSHA256(this.chainKey, CK_MSG);
    this.chainKey = await hmacSHA256(this.chainKey, CK_NEXT);
    this.messageNumber++;

    const aesKey = await deriveAESKey(msgKey, undefined, 'vault-group-encrypt');
    return await decrypt(aesKey, packet.iv, packet.ciphertext);
  }
}
