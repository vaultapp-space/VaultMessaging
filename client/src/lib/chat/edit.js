// ============================================================
// Vault — Message Editing
// ============================================================
// Same shape as reactions: one function, forking on chat mode.
//
//   cloud  → PATCH the message; the server rewrites the row, stamps
//            `edited_at`, and broadcasts to every member.
//   secret → an `t:'op'` envelope carrying the new body, encrypted through
//            the ratchet and applied locally by each recipient.
//
// There is no edit *window*. Telegram allows 48 hours; every message here is
// deleted 24 hours after it was sent, so a longer window could never be
// exercised. A message is editable for exactly as long as it exists.

import { get } from 'svelte/store';

import { currentUser } from '../stores/session.js';
import { messagesByPeer } from '../stores/messages.js';
import { editCloudMessage } from '../api/http.js';
import { createOpEnvelope, OpKind } from '$shared/envelope.js';
import { capabilities } from '$shared/capabilities.js';
import { sendMessage } from './send.js';

/** Rewrites a message in the store and marks it edited. */
export function applyEdit(storeKey, { seq, body, editedAt = new Date().toISOString() }) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], text: body, body, editedAt };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

/** True if this user may edit the message. */
export function canEdit(message, userId) {
  return Boolean(
    message
    && message.seq
    && userId
    && message.senderId === userId
    && !message.media          // editing media is a later feature
    && !message.deletedAt
  );
}

/**
 * Edits a message in either mode.
 *
 * @param {object} chat    - { id, mode }
 * @param {object} message - must carry `seq`
 * @param {string} body    - the new text
 * @param {object} context - { storeKey, peer, currentUser, ttlMinutes, chatId }
 */
export async function editMessage(chat, message, body, context = {}) {
  const me = context.currentUser?.id || get(currentUser)?.id;
  if (!canEdit(message, me)) return;

  const trimmed = body.trim();
  if (!trimmed || trimmed === message.text) return;

  const storeKey = context.storeKey || context.peer?.id || chat.id;
  const previous = { text: message.text, editedAt: message.editedAt };

  // Optimistic, so the correction lands immediately rather than after a
  // round trip.
  applyEdit(storeKey, { seq: message.seq, body: trimmed });

  try {
    if (capabilities(chat).isCloud) {
      const result = await editCloudMessage(chat.id, message.seq, trimmed);
      applyEdit(storeKey, { seq: message.seq, body: result.body, editedAt: result.editedAt });
    } else {
      await sendMessage(
        chat,
        createOpEnvelope({ kind: OpKind.EDIT, seq: message.seq, body: trimmed }),
        context
      );
    }
  } catch (err) {
    // Put the original text back rather than leaving the UI showing an edit
    // that was never recorded.
    applyEdit(storeKey, { seq: message.seq, body: previous.text, editedAt: previous.editedAt });
    throw err;
  }
}
