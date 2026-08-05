// ============================================================
// Vault — Message Actions
// ============================================================
// Delete and pin, both forking on chat mode exactly as reactions and edits
// do. Grouped here rather than one file each because they share the same
// three-line shape: optimistic update, mode fork, rollback on failure.

import { get } from 'svelte/store';

import { currentUser } from '../stores/session.js';
import { messagesByPeer } from '../stores/messages.js';
import { deleteMessage as apiDelete, pinMessage, unpinMessage } from '../api/http.js';
import { createOpEnvelope, OpKind } from '$shared/envelope.js';
import { capabilities } from '$shared/capabilities.js';
import { sendMessage } from './send.js';

/** Removes a message from the local view entirely (delete for me). */
export function removeLocally(storeKey, seq) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    map.set(storeKey, messages.filter((m) => m.seq !== seq));
    return new Map(map);
  });
}

/**
 * Replaces a message with a tombstone (delete for everyone).
 *
 * The row is kept rather than removed so the transcript keeps its shape —
 * a message vanishing without trace reads as a sync bug, where "this message
 * was deleted" reads as what actually happened.
 */
export function tombstoneLocally(storeKey, seq) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = {
      ...messages[idx],
      text: 'This message was deleted',
      body: null,
      media: null,
      reactions: [],
      deletedAt: new Date().toISOString(),
    };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

/** Attaches a link preview to a message once the server has unfurled it. */
export function setPreview(storeKey, seq, preview) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], preview };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

// Poll tallies are per-viewer, so unlike reactions they cannot be broadcast
// with the update: the server sends only a nudge and each client refetches
// its own view of the results.
export function setPoll(storeKey, seq, poll) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], poll };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

// Strips a view-once message's content locally once the server has cleared
// it. Deliberately not a tombstone: `deletedAt` renders "this message was
// deleted", which is a different and misleading thing to say about a message
// that was opened exactly as intended.
export function consumeViewOnce(storeKey, seq) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], text: null, body: null, media: null, viewOnce: true };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

export function setPinned(storeKey, seq, pinnedAt) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], pinnedAt };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

/** True if this user may unsend the message for everyone. */
export function canDeleteForEveryone(message, userId) {
  return Boolean(message && message.seq && userId && message.senderId === userId);
}

/**
 * Deletes a message.
 *
 * `forEveryone` defaults to false deliberately: hiding something from
 * yourself is recoverable in a way that destroying everyone's copy is not.
 */
export async function deleteMessage(chat, message, { forEveryone = false, ...context } = {}) {
  const me = context.currentUser?.id || get(currentUser)?.id;
  if (!message?.seq) return;

  const storeKey = context.storeKey || context.peer?.id || chat.id;

  if (!forEveryone) {
    removeLocally(storeKey, message.seq);
    if (capabilities(chat).isCloud) {
      await apiDelete(chat.id, message.seq, false);
    }
    // Secret chats have no server-side per-user state to record; hiding it
    // locally is the whole operation.
    return;
  }

  if (!canDeleteForEveryone(message, me)) return;

  tombstoneLocally(storeKey, message.seq);

  if (capabilities(chat).isCloud) {
    await apiDelete(chat.id, message.seq, true);
  } else {
    await sendMessage(
      chat,
      createOpEnvelope({ kind: OpKind.DELETE, seq: message.seq }),
      context
    );
  }
}

export async function togglePin(chat, message, context = {}) {
  if (!message?.seq) return;
  const storeKey = context.storeKey || context.peer?.id || chat.id;
  const wasPinned = Boolean(message.pinnedAt);

  setPinned(storeKey, message.seq, wasPinned ? null : new Date().toISOString());

  try {
    if (capabilities(chat).isCloud) {
      if (wasPinned) await unpinMessage(chat.id, message.seq);
      else await pinMessage(chat.id, message.seq);
    } else {
      await sendMessage(
        chat,
        createOpEnvelope({
          kind: wasPinned ? OpKind.UNPIN : OpKind.PIN,
          seq: message.seq,
        }),
        context
      );
    }
  } catch (err) {
    setPinned(storeKey, message.seq, wasPinned ? message.pinnedAt : null);
    throw err;
  }
}
