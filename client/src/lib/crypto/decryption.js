// ============================================================
// Vault — E2EE Decryption Manager
// Handles Double Ratchet, X3DH responder handshake,
// and Self-History decryption.
// ============================================================

import { get } from 'svelte/store';
import {
  currentUser,
  ratchetSessions,
  identityKeyPair,
  signedPrekeyPair,
  oneTimePrekeyPairs,
  historyKey,
  groupSenderKeys
} from '../stores/session.js';
import { decrypt as aesDecrypt } from './keys.js';
import { x3dhRespond, deriveInitialKeys } from './x3dh.js';
import { RatchetSession } from './ratchet.js';
import { SenderKeySession } from './senderkeys.js';
import { syncCloudVault } from './sync.js';

const initLocks = new Map();

/**
 * Decrypt a single message.
 * Supports self-history and Double Ratchet decryption.
 * @param {object} msg - Encrypted message object from server/store
 * @returns {Promise<object>} - Decrypted message object
 */
export async function decryptMessage(msg) {
  // If already decrypted or not encrypted, return as-is
  if (!msg.encrypted) return msg;

  try {
    // 1. Base64 decode and parse the double-encrypted payload
    const jsonStr = atob(msg.text);
    const parsed = JSON.parse(jsonStr);

    const currentUserId = get(currentUser)?.id;
    const isOwn = msg.senderId === currentUserId;

    if (isOwn) {
      // ─── Decrypt using historyKey ──────────────────────────
      const hk = get(historyKey);
      if (!hk) throw new Error('No history key derived');
      
      const decrypted = await aesDecrypt(hk, parsed.self.iv, parsed.self.ct);
      return {
        ...msg,
        text: decrypted,
        encrypted: false
      };
    } else {
      // Check if it is a Sender Key group message
      if (parsed.bob && parsed.bob.senderKey) {
        const sk = parsed.bob.senderKey;
        const sessionKey = `${sk.groupId}:${msg.senderId}`;
        const session = get(groupSenderKeys).get(sessionKey);
        if (!session) {
          throw new Error('No group sender key session found for sender.');
        }

        const plaintext = await session.decrypt({
          messageNumber: sk.messageNumber,
          iv: parsed.bob.iv,
          ciphertext: parsed.bob.ct,
          signature: sk.signature
        });

        // Check if it's a senderkey distribution payload
        try {
          const payload = JSON.parse(plaintext);
          if (payload.type === 'senderkey_distribution') {
            const innerSessionKey = `${payload.groupId}:${msg.senderId}`;
            let innerSession = get(groupSenderKeys).get(innerSessionKey);
            if (!innerSession) {
              innerSession = new SenderKeySession(msg.senderId, payload.groupId);
            }
            await innerSession.importDistributionPackage(payload.pack);
            groupSenderKeys.update(m => { m.set(innerSessionKey, innerSession); return m; });
            
            await syncCloudVault();
            
            return {
              ...msg,
              text: '🔒 Group session key received.',
              encrypted: false
            };
          }
        } catch {}

        await syncCloudVault();

        return {
          ...msg,
          text: plaintext,
          encrypted: false
        };
      }

      // ─── Decrypt using Double Ratchet ──────────────────────
      // Parse key agreement metadata from ephemeralKey field
      const ephData = JSON.parse(msg.ephemeralKey);

      let sessions = get(ratchetSessions);
      let ratchet = sessions.get(msg.senderId);

      // Protocol Healing: If the incoming message is an X3DH initiation,
      // we must discard any existing session for the sender to establish a fresh one.
      if (ephData.type === 'x3dh') {
        if (ratchet) {
          if (ratchet.destroy) {
            try { ratchet.destroy(); } catch (e) { console.error('Error destroying old ratchet:', e); }
          }
          ratchet = null;
          ratchetSessions.update(map => {
            map.delete(msg.senderId);
            return new Map(map);
          });
        }
      }

      if (!ratchet) {
        // Handle concurrent initialization races for the same sender
        if (initLocks.has(msg.senderId)) {
          ratchet = await initLocks.get(msg.senderId);
        } else {
          const initPromise = (async () => {
            if (ephData.type !== 'x3dh') {
              throw new Error('Ratchet session not initialized and message is not X3DH');
            }

            const ikp = get(identityKeyPair);
            const spk = get(signedPrekeyPair);
            const otps = get(oneTimePrekeyPairs);

            if (!ikp || !spk) {
              throw new Error('Identity or signed prekey not loaded');
            }

            // Find Bob's matching one-time prekey pair (performance optimized using pre-computed base64 keys)
            let otpPair = null;
            if (ephData.opk) {
              const found = otps.find(kp => kp.pubKeyBase64 === ephData.opk);
              if (found) {
                otpPair = found.keyPair;
              }
            }

            // Perform X3DH responder handshake
            const { sharedSecret } = await x3dhRespond(
              ikp,
              spk,
              otpPair,
              ephData.ik,
              ephData.ek
            );

            // Derive initial keys
            const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

            // Initialize ratchet session as receiver
            const newRatchet = new RatchetSession();
            await newRatchet.initAsReceiver(rootKey, chainKey, spk, ephData.ik);

            // Store ratchet in volatile memory
            ratchetSessions.update(map => {
              map.set(msg.senderId, newRatchet);
              return new Map(map);
            });

            return newRatchet;
          })();

          initLocks.set(msg.senderId, initPromise);
          try {
            ratchet = await initPromise;
          } finally {
            initLocks.delete(msg.senderId);
          }
        }
      }

      // Decrypt message using Double Ratchet
      const header = {
        publicKey: ephData.rk,
        messageNumber: msg.messageNumber,
        previousChainLength: msg.previousChain
      };

      const decrypted = await ratchet.ratchetDecrypt(
        header,
        parsed.bob.iv,
        parsed.bob.ct
      );

      await syncCloudVault();

      return {
        ...msg,
        text: decrypted,
        encrypted: false
      };
    }
  } catch (err) {
    console.error('[Decryption] Failed for message:', msg.id, err);
    return {
      ...msg,
      text: '🔒 Decryption failed: ' + err.message,
      encrypted: true, // Keep marked as encrypted/locked
      decryptionError: true
    };
  }
}

import { importStaticKey } from './keys.js';
import { fromBase64 } from './utils.js';

export async function decryptSignalingPayload(senderId, data) {
  if (!data || !data.ciphertext) {
    return data;
  }

  try {
    const ephData = JSON.parse(data.ephemeralKey);
    let sessions = get(ratchetSessions);
    let ratchet = sessions.get(senderId);

    if (ephData.type === 'x3dh') {
      if (ratchet) {
        ratchet = null;
        ratchetSessions.update(map => {
          map.delete(senderId);
          return new Map(map);
        });
      }
    }

    if (!ratchet) {
      const ikp = get(identityKeyPair);
      const spk = get(signedPrekeyPair);
      const otps = get(oneTimePrekeyPairs);

      if (!ikp || !spk) {
        throw new Error('Identity or signed prekey not loaded');
      }

      let otpPair = null;
      if (ephData.opk) {
        const found = otps.find(kp => kp.pubKeyBase64 === ephData.opk);
        if (found) {
          otpPair = found.keyPair;
        }
      }

      const { sharedSecret } = await x3dhRespond(
        ikp,
        spk,
        otpPair,
        ephData.ik,
        ephData.ek
      );

      const { rootKey, chainKey } = await deriveInitialKeys(sharedSecret);

      const newRatchet = new RatchetSession();
      await newRatchet.initAsReceiver(rootKey, chainKey, spk, ephData.ik);

      ratchetSessions.update(map => {
        map.set(senderId, newRatchet);
        return new Map(map);
      });

      ratchet = newRatchet;
    }

    const jsonStr = atob(data.ciphertext);
    const parsed = JSON.parse(jsonStr);

    const header = {
      publicKey: ephData.rk,
      messageNumber: data.messageNumber,
      previousChainLength: data.previousChain,
    };

    const plaintext = await ratchet.ratchetDecrypt(header, parsed.bob.iv, parsed.bob.ct);
    await syncCloudVault();
    
    return JSON.parse(plaintext);
  } catch (err) {
    console.error('Failed to decrypt E2EE signaling payload:', err);
    return null;
  }
}
