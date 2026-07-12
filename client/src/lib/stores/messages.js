// ============================================================
// Vault — Message Store (Volatile Memory Only)
// ============================================================

import { writable, derived, get } from 'svelte/store';
import { decryptMessage } from '../crypto/decryption.js';

// Map<peerId, Message[]> — all in volatile memory
export const messagesByPeer = writable(new Map());

// Set of known message IDs for O(1) duplicate detection
const knownMessageIds = new Set();

// Conversations list from server
export const conversations = writable([]);

// Typing indicators
export const typingUsers = writable(new Map()); // peerId → timestamp

/**
 * Add a message to the volatile store and decrypt it if encrypted.
 */
export function addMessage(peerId, message) {
  // O(1) duplicate check instead of O(n) .find()
  if (knownMessageIds.has(message.id)) return;
  knownMessageIds.add(message.id);

  if (message.encrypted) {
    message.decrypting = true;
  }

  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    messages.push(message);
    messages.sort((a, b) => a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0);
    map.set(peerId, messages);
    return new Map(map);
  });

  // If encrypted, decrypt asynchronously and update in place
  if (message.encrypted) {
    decryptMessage(message).then(decryptedMsg => {
      messagesByPeer.update(map => {
        const messages = map.get(peerId) || [];
        const idx = messages.findIndex(m => m.id === message.id);
        if (idx !== -1) {
          messages[idx] = { ...decryptedMsg, decrypting: false };
        }
        map.set(peerId, messages);
        return new Map(map);
      });
    });
  }
}

/**
 * Add multiple messages at once — single re-render instead of N.
 * Use this when processing batches (e.g., pending messages, history loads).
 */
export function addMessages(peerId, newMessages) {
  // Filter out duplicates in one pass
  const toAdd = newMessages.filter(m => {
    if (knownMessageIds.has(m.id)) return false;
    knownMessageIds.add(m.id);
    if (m.encrypted) {
      m.decrypting = true;
    }
    return true;
  });

  if (toAdd.length === 0) return;

  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    messages.push(...toAdd);
    messages.sort((a, b) => a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0);
    map.set(peerId, messages);
    return new Map(map);
  });

  // Batch decrypt all encrypted messages
  const encrypted = toAdd.filter(m => m.encrypted);
  if (encrypted.length > 0) {
    Promise.all(encrypted.map(m => decryptMessage(m))).then(decryptedMsgs => {
      messagesByPeer.update(map => {
        const messages = map.get(peerId) || [];
        for (const decrypted of decryptedMsgs) {
          const idx = messages.findIndex(m => m.id === decrypted.id);
          if (idx !== -1) {
            messages[idx] = { ...decrypted, decrypting: false };
          }
        }
        map.set(peerId, messages);
        return new Map(map);
      });
    });
  }
}

/**
 * Add a message optimistically (before server confirms).
 */
export function addOptimisticMessage(peerId, message) {
  knownMessageIds.add(message.id);
  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    messages.push({ ...message, optimistic: true, status: 'sending' });
    map.set(peerId, messages);
    return new Map(map);
  });
}

/**
 * Confirm an optimistic message with server data.
 */
export function confirmMessage(peerId, tempId, serverData) {
  // Replace the temp ID tracking with the real ID
  knownMessageIds.delete(tempId);
  knownMessageIds.add(serverData.id || tempId);

  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    const idx = messages.findIndex(m => m.id === tempId);
    if (idx !== -1) {
      messages[idx] = { ...messages[idx], ...serverData, optimistic: false, status: 'sent' };
    }
    map.set(peerId, messages);
    return new Map(map);
  });
}

export function updateMessageStatus(peerId, messageId, status) {
  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      const current = messages[idx].status || 'sent';
      if (
        (status === 'delivered' && current !== 'read') ||
        status === 'read'
      ) {
        messages[idx] = { ...messages[idx], status };
      }
    }
    map.set(peerId, messages);
    return new Map(map);
  });
}

/**
 * Get messages for a peer.
 */
export function getMessages(peerId) {
  const map = get(messagesByPeer);
  return map.get(peerId) || [];
}

/**
 * Set typing indicator for a peer.
 */
export function setTyping(peerId) {
  typingUsers.update(map => {
    map.set(peerId, Date.now());
    return new Map(map);
  });

  // Auto-clear after 3 seconds
  setTimeout(() => {
    typingUsers.update(map => {
      const ts = map.get(peerId);
      if (ts && Date.now() - ts >= 2900) {
        map.delete(peerId);
      }
      return new Map(map);
    });
  }, 3000);
}

/**
 * Update message delivery status in store.
 */
export function updateMessageDeliveryStatus(peerId, messageId, delivered) {
  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      messages[idx] = { ...messages[idx], delivered };
    }
    map.set(peerId, messages);
    return new Map(map);
  });
}

/**
 * Clear all messages (on logout).
 */
export function clearMessages() {
  messagesByPeer.set(new Map());
  conversations.set([]);
  typingUsers.set(new Map());
  knownMessageIds.clear();
}

/**
 * Start periodic client-side reaper to delete expired messages.
 */
function startClientReaper() {
  setInterval(() => {
    const now = Date.now();
    let updated = false;

    messagesByPeer.update(map => {
      const newMap = new Map();
      for (const [peerId, messages] of map.entries()) {
        const filtered = messages.filter(m => {
          if (m.expiresAt && new Date(m.expiresAt).getTime() <= now) {
            knownMessageIds.delete(m.id);
            updated = true;
            return false;
          }
          return true;
        });
        if (filtered.length !== messages.length) {
          newMap.set(peerId, filtered);
        } else {
          newMap.set(peerId, messages);
        }
      }
      return updated ? newMap : map;
    });
  }, 10000); // Check every 10 seconds
}

// Start the reaper
if (typeof window !== 'undefined') {
  startClientReaper();
}

// ─── IndexedDB Local Backup Save & Restore ───────────────────
import { currentUser, localBackupEnabled, localBackupPassphrase, localBackupKey } from './session.js';
import { encryptLocalDB, decryptLocalDB } from '../crypto/keys.js';
import { saveEncryptedBackup, loadEncryptedBackup, clearEncryptedBackup } from '../db.js';

// Auto-save message database to IndexedDB when messages change (debounced)
if (typeof window !== 'undefined') {
  let backupTimer = null;
  messagesByPeer.subscribe((map) => {
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
      const enabled = get(localBackupEnabled);
      const passphrase = get(localBackupPassphrase);
      const user = get(currentUser);
      const cachedKey = get(localBackupKey);

      if (enabled && passphrase && user) {
        try {
          const plainData = [];
          for (const [peerId, list] of map) {
            const savedList = list.map(m => ({
              id: m.id,
              senderId: m.senderId,
              text: m.text,
              encrypted: m.encrypted,
              decryptionError: m.decryptionError,
              sentAt: m.sentAt,
              expiresAt: m.expiresAt
            }));
            plainData.push({ peerId, messages: savedList });
          }

          const serialized = JSON.stringify(plainData);
          const { encryptedJson, derivedKey } = await encryptLocalDB(serialized, passphrase, cachedKey);
          if (derivedKey && !cachedKey) {
            localBackupKey.set(derivedKey);
          }
          await saveEncryptedBackup(user.id, encryptedJson);
        } catch (err) {
          console.error('Failed to auto-save encrypted local backup:', err);
        }
      }
    }, 5000);
  });
}

export async function restoreBackup() {
  const enabled = get(localBackupEnabled);
  const passphrase = get(localBackupPassphrase);
  const user = get(currentUser);
  const cachedKey = get(localBackupKey);

  if (!enabled || !passphrase || !user) return false;

  try {
    const encryptedJson = await loadEncryptedBackup(user.id);
    if (!encryptedJson) return false;

    const { decryptedText, derivedKey } = await decryptLocalDB(encryptedJson, passphrase, cachedKey);
    if (derivedKey && !cachedKey) {
      localBackupKey.set(derivedKey);
    }
    const parsed = JSON.parse(decryptedText);

    messagesByPeer.update(map => {
      for (const item of parsed) {
        for (const m of item.messages) {
          knownMessageIds.add(m.id);
        }
        map.set(item.peerId, item.messages);
      }
      return new Map(map);
    });

    return true;
  } catch (err) {
    console.error('Failed to restore encrypted local backup:', err);
    throw new Error('Invalid passphrase or corrupted backup');
  }
}

export async function clearBackup() {
  const user = get(currentUser);
  if (user) {
    await clearEncryptedBackup(user.id);
  }
}
