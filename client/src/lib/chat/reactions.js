// ============================================================
// Vault — Reactions
// ============================================================
// One reaction API for both chat modes, and the clearest demonstration of why
// the `t:'op'` envelope exists.
//
//   cloud  → an HTTP call mutates a table; the server broadcasts the new
//            summary to every member.
//   secret → the identical operation is packed into an envelope, encrypted
//            through the existing ratchet, and sent as an ordinary message.
//            Recipients apply it locally. The server stores ciphertext and
//            learns nothing about who reacted to what.
//
// The UI calls `toggleReaction` and never learns which happened.
//
// Summaries are shaped the same either way — [{ emoji, count, users }] — so
// MessageBubble renders one thing. In cloud mode the server computes it; in
// secret mode it is folded locally by `applySummary` below, because there is
// nobody else who can.

import { get } from 'svelte/store';

import { currentUser } from '../stores/session.js';
import { messagesByPeer } from '../stores/messages.js';
import { addReaction, removeReaction } from '../api/http.js';
import { createOpEnvelope, OpKind } from '$shared/envelope.js';
import { capabilities } from '$shared/capabilities.js';
import { sendMessage } from './send.js';

/** True if `userId` has already reacted with `emoji`. */
export function hasReacted(reactions, emoji, userId) {
  const entry = (reactions || []).find((r) => r.emoji === emoji);
  return Boolean(entry && entry.users?.includes(userId));
}

/**
 * Folds a single add/remove into a summary, returning a new array.
 *
 * Used for secret chats, where no server computes this, and for optimistic
 * updates in cloud chats so the reaction appears on tap rather than after a
 * round trip.
 */
export function applySummary(reactions, { emoji, userId, add }) {
  const next = (reactions || []).map((r) => ({ ...r, users: [...(r.users || [])] }));
  const entry = next.find((r) => r.emoji === emoji);

  if (add) {
    if (!entry) {
      next.push({ emoji, count: 1, users: [userId] });
    } else if (!entry.users.includes(userId)) {
      entry.users.push(userId);
      entry.count = entry.users.length;
    }
  } else if (entry) {
    entry.users = entry.users.filter((u) => u !== userId);
    entry.count = entry.users.length;
  }

  // An emoji nobody is using should disappear rather than linger at zero.
  return next
    .filter((r) => r.count > 0)
    .sort((a, b) => a.emoji.localeCompare(b.emoji));
}

/** Writes a summary onto a message in the store. */
export function setReactions(storeKey, seq, reactions) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    messages[idx] = { ...messages[idx], reactions };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

/** Applies an incoming reaction op — the secret-chat receive path. */
export function applyReactionOp(storeKey, { seq, emoji, userId, add }) {
  messagesByPeer.update((map) => {
    const messages = map.get(storeKey);
    if (!messages) return map;
    const idx = messages.findIndex((m) => m.seq === seq);
    if (idx === -1) return map;
    const message = messages[idx];
    messages[idx] = {
      ...message,
      reactions: applySummary(message.reactions, { emoji, userId, add }),
    };
    map.set(storeKey, [...messages]);
    return new Map(map);
  });
}

/**
 * Adds the reaction if absent, removes it if present.
 *
 * @param {object} chat    - { id, mode }
 * @param {object} message - must carry `seq`
 * @param {string} emoji
 * @param {object} context - { storeKey, peer, currentUser, ttlMinutes }
 */
export async function toggleReaction(chat, message, emoji, context = {}) {
  const me = context.currentUser?.id || get(currentUser)?.id;
  if (!me || !message?.seq) return;

  const storeKey = context.storeKey || context.peer?.id || chat.id;
  const previous = message.reactions || [];
  const add = !hasReacted(previous, emoji, me);

  // Optimistic: the reaction should appear on tap, not after a round trip.
  setReactions(storeKey, message.seq, applySummary(previous, { emoji, userId: me, add }));

  try {
    if (capabilities(chat).isCloud) {
      const { reactions } = add
        ? await addReaction(chat.id, message.seq, emoji)
        : await removeReaction(chat.id, message.seq, emoji);
      // Trust the server's summary over the optimistic one — it is the only
      // view that accounts for reactions added concurrently by other people.
      setReactions(storeKey, message.seq, reactions);
    } else {
      await sendMessage(
        chat,
        createOpEnvelope({
          kind: add ? OpKind.REACT : OpKind.UNREACT,
          seq: message.seq,
          emoji,
        }),
        context
      );
    }
  } catch (err) {
    // Roll the optimistic update back rather than leaving the UI claiming a
    // reaction that was never recorded.
    setReactions(storeKey, message.seq, previous);
    throw err;
  }
}
