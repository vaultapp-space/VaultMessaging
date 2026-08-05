// ============================================================
// Vault — Message Store (Volatile Memory Only)
// ============================================================

import { writable, get } from 'svelte/store';
import { decryptMessage } from '../crypto/decryption.js';
import { normalizeMessage } from '../chat/normalize.js';
import { applyReactionOp } from '../chat/reactions.js';
import { applyEdit } from '../chat/edit.js';
import { tombstoneLocally, setPinned } from '../chat/actions.js';
import { MessageType, OpKind } from '$shared/envelope.js';

// Brings a message into the shared shape regardless of which mode it came
// from: a cloud message arrives with plaintext columns, a secret one only
// after its ratchet has run.
//
// The normalized fields are overlaid onto the raw message rather than
// replacing it. Consumers still read fields normalize() does not model —
// groupId/groupName/groupMembers for group fan-out, and the transient
// status/optimistic/decrypting flags the UI sets — and dropping those would
// break group rendering and the sending spinner.
function withEnvelope(raw, decryptedText = null) {
  const normalized = normalizeMessage(raw, { decryptedText });
  return normalized ? { ...raw, ...normalized } : raw;
}

// Operations (reactions, edits, deletes…) arrive in secret chats as ordinary
// encrypted messages carrying a `t:'op'` envelope. They must be *applied* and
// then dropped — rendering one would show the recipient a raw operation where
// a message should be.
//
// This only *detects* an op. Applying it has to happen after the enclosing
// messagesByPeer.update() has returned: applying inside would mean calling
// update() re-entrantly, and the outer callback's return value then overwrites
// whatever the inner one wrote. That failure is silent — the op is consumed,
// nothing renders, and no error is logged anywhere.
function isOperation(message) {
  const envelope = message?.envelope;
  return Boolean(envelope && envelope.t === MessageType.OP && envelope.op);
}

// In a secret chat there is no server to enforce who may edit what, so the
// check has to happen here: an edit is applied only when the sender of the op
// is the author of the message it targets.
function applyEditIfAuthor(peerId, senderId, op) {
  const messages = get(messagesByPeer).get(peerId) || [];
  const target = messages.find((m) => m.seq === op.seq);
  if (!target || target.senderId !== senderId) return;
  applyEdit(peerId, { seq: op.seq, body: op.body });
}

function applyDeleteIfAuthor(peerId, senderId, op) {
  const messages = get(messagesByPeer).get(peerId) || [];
  const target = messages.find((m) => m.seq === op.seq);
  if (!target || target.senderId !== senderId) return;
  tombstoneLocally(peerId, op.seq);
}

// Applies ops collected during an update, once that update has committed.
// Unknown kinds are swallowed rather than displayed: a future client sending
// an op this build does not understand should be invisible, not garbage in
// the transcript.
function applyOperations(peerId, ops) {
  for (const { op, senderId } of ops) {
    if (op.kind === OpKind.REACT || op.kind === OpKind.UNREACT) {
      applyReactionOp(peerId, {
        seq: op.seq,
        emoji: op.emoji,
        userId: senderId,
        add: op.kind === OpKind.REACT,
      });
    } else if (op.kind === OpKind.DELETE) {
      // Same authorship rule as edit: only the author may unsend, and in a
      // secret chat there is no server to enforce it.
      applyDeleteIfAuthor(peerId, senderId, op);
    } else if (op.kind === OpKind.PIN || op.kind === OpKind.UNPIN) {
      // Pinning is a shared surface — any member may pin — so no author check.
      setPinned(peerId, op.seq, op.kind === OpKind.PIN ? new Date().toISOString() : null);
    } else if (op.kind === OpKind.EDIT) {
      // Only the author's own edit is honoured. Without this check any member
      // of a group could rewrite anyone else's message by sending an edit op,
      // since there is no server to arbitrate in a secret chat.
      applyEditIfAuthor(peerId, senderId, op);
    }
  }
}

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

  // The id check alone is not enough for a message this client sent itself.
  // It goes into the list optimistically under a temporary id, and the server
  // fans the real one back out to every member — the sender included, because
  // that broadcast is also what syncs the message to their other devices. If
  // it wins the race against the HTTP response, the same message is in the
  // list twice under two different ids.
  //
  // `clientRandomId` is the sender's own tag for the send, echoed back, so
  // the match is exact rather than a guess; `(chatId, seq)` catches a message
  // that arrives twice by any other route, such as history overlapping a
  // send still in flight.
  const existing = get(messagesByPeer).get(peerId) || [];
  const isOwnEcho = message.clientRandomId != null
    && existing.some((m) => m.clientRandomId === message.clientRandomId);
  const alreadyHere = message.chatId && message.seq != null
    && existing.some((m) => m.chatId === message.chatId && m.seq === message.seq);
  if (isOwnEcho || alreadyHere) {
    knownMessageIds.add(message.id);
    return;
  }

  knownMessageIds.add(message.id);

  // The message itself is proof the sender is done typing it. Without this,
  // "typing…" only clears on its own 3-second timer, so a message that
  // arrives sooner than that renders next to an indicator for something
  // that has already been sent — looking stuck rather than live.
  if (message.senderId) {
    typingUsers.update(map => {
      if (!map.has(message.senderId)) return map;
      map.delete(message.senderId);
      return new Map(map);
    });
  }

  if (message.encrypted) {
    message.decrypting = true;
  }

  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    // A cloud message is already plaintext and can be shaped immediately;
    // a secret one is shaped below, once decryption has run.
    messages.push(message.encrypted ? message : withEnvelope(message));
    messages.sort((a, b) => a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0);
    map.set(peerId, messages);
    return new Map(map);
  });

  // If encrypted, decrypt asynchronously and update in place
  if (message.encrypted) {
    decryptMessage(message).then(decryptedMsg => {
      const pendingOps = [];
      messagesByPeer.update(map => {
        const messages = map.get(peerId) || [];
        const idx = messages.findIndex(m => m.id === message.id);
        if (idx !== -1) {
          const shaped = { ...withEnvelope(decryptedMsg, decryptedMsg.text), decrypting: false };
          if (isOperation(shaped)) {
            pendingOps.push({ op: shaped.envelope.op, senderId: shaped.senderId });
            messages.splice(idx, 1);   // consumed, never rendered
          } else {
            messages[idx] = shaped;
          }
        }
        map.set(peerId, messages);
        return new Map(map);
      });
      applyOperations(peerId, pendingOps);
    });
  }
}

/**
 * Add multiple messages at once — single re-render instead of N.
 * Use this when processing batches (e.g., pending messages, history loads).
 */
export function addMessages(peerId, newMessages) {
  // History can overlap with a send still in flight: the message is in the
  // list under a temporary id and comes back from the server under its real
  // one. `(chatId, seq)` is the identity the ids do not yet agree on.
  const present = get(messagesByPeer).get(peerId) || [];
  const seenSeqs = new Set(
    present.filter(m => m.chatId && m.seq != null).map(m => `${m.chatId}:${m.seq}`)
  );

  // Filter out duplicates in one pass
  const toAdd = newMessages.filter(m => {
    if (knownMessageIds.has(m.id)) return false;
    const key = m.chatId && m.seq != null ? `${m.chatId}:${m.seq}` : null;
    if (key && seenSeqs.has(key)) {
      knownMessageIds.add(m.id);
      return false;
    }
    if (key) seenSeqs.add(key);
    knownMessageIds.add(m.id);
    if (m.encrypted) {
      m.decrypting = true;
    }
    return true;
  });

  if (toAdd.length === 0) return;

  messagesByPeer.update(map => {
    const messages = map.get(peerId) || [];
    messages.push(...toAdd.map(m => (m.encrypted ? m : withEnvelope(m))));
    messages.sort((a, b) => a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0);
    map.set(peerId, messages);
    return new Map(map);
  });

  // Batch decrypt all encrypted messages
  const encrypted = toAdd.filter(m => m.encrypted);
  if (encrypted.length > 0) {
    Promise.all(encrypted.map(m => decryptMessage(m))).then(decryptedMsgs => {
      const pendingOps = [];
      messagesByPeer.update(map => {
        const messages = map.get(peerId) || [];
        for (const decrypted of decryptedMsgs) {
          const idx = messages.findIndex(m => m.id === decrypted.id);
          if (idx === -1) continue;
          const shaped = { ...withEnvelope(decrypted, decrypted.text), decrypting: false };
          if (isOperation(shaped)) {
            pendingOps.push({ op: shaped.envelope.op, senderId: shaped.senderId });
            messages.splice(idx, 1);
          } else {
            messages[idx] = shaped;
          }
        }
        map.set(peerId, messages);
        return new Map(map);
      });
      applyOperations(peerId, pendingOps);
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
    if (idx === -1) {
      map.set(peerId, messages);
      return new Map(map);
    }

    // The other half of the race: the broadcast already inserted this message
    // under its real id, so promoting the optimistic copy would leave two of
    // it. Drop the placeholder and keep the server's version.
    const alreadyArrived = serverData.seq != null && messages.some(
      (m, i) => i !== idx && m.chatId === serverData.chatId && m.seq === serverData.seq
    );
    if (alreadyArrived) {
      messages.splice(idx, 1);
    } else {
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
              senderUsername: m.senderUsername,
              text: m.text,
              encrypted: m.encrypted,
              decryptionError: m.decryptionError,
              sentAt: m.sentAt,
              expiresAt: m.expiresAt,
              groupId: m.groupId,
              attachmentId: m.attachmentId
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
        const currentMessages = map.get(item.peerId) || [];
        const combined = [...item.messages];
        const backupIds = new Set(item.messages.map(m => m.id));
        for (const m of currentMessages) {
          if (!backupIds.has(m.id)) {
            combined.push(m);
          }
        }
        for (const m of combined) {
          knownMessageIds.add(m.id);
        }
        combined.sort((a, b) => {
          const tA = new Date(a.sentAt).getTime();
          const tB = new Date(b.sentAt).getTime();
          return tA - tB;
        });
        map.set(item.peerId, combined);
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
