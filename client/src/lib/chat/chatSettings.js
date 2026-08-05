// ============================================================
// Vault — Chat-level actions
// ============================================================
// Mute, archive, pin-to-top, drafts, blocking and presence.
//
// Unlike reactions or edits, none of these touch message content, so none of
// them fork on chat mode — with one exception: drafts are plaintext, so a
// secret chat keeps them on the device and never calls the server. That check
// lives in `saveDraftFor` rather than at each call site.

import { get, writable } from 'svelte/store';

import { conversations } from '../stores/messages.js';
import {
  updateChatSettings, saveDraft as apiSaveDraft, fetchDrafts,
  blockUser, unblockUser, fetchBlocked, fetchPresence, searchMessages,
} from '../api/http.js';
import { capabilities } from '$shared/capabilities.js';

// userId -> { online, lastSeenAt }
export const presence = writable(new Map());

// chatId -> draft body. Secret-chat drafts live only here.
const localDrafts = new Map();

function patchConversation(chatId, patch) {
  conversations.update((cs) => {
    const conv = cs.find((c) => c.chatId === chatId);
    if (conv) Object.assign(conv, patch);
    return [...cs];
  });
}

// ─── Mute / archive / pin ─────────────────────────────────

export async function setMuted(chat, muted) {
  // 'infinity' is not representable in JSON; a far-future timestamp is the
  // usual way to mean "until I say otherwise".
  const mutedUntil = muted
    ? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
    : null;

  patchConversation(chat.chatId, { mutedUntil });
  try {
    await updateChatSettings(chat.chatId, { mutedUntil });
  } catch (err) {
    patchConversation(chat.chatId, { mutedUntil: muted ? null : chat.mutedUntil });
    throw err;
  }
}

export function isMuted(conv) {
  return Boolean(conv?.mutedUntil && new Date(conv.mutedUntil) > new Date());
}

export async function setArchived(chat, archived) {
  patchConversation(chat.chatId, { archived });
  try {
    await updateChatSettings(chat.chatId, { archived });
  } catch (err) {
    patchConversation(chat.chatId, { archived: !archived });
    throw err;
  }
}

export async function setPinnedToTop(chat, pinned) {
  // Lower sorts first; a single order value is enough until users can reorder
  // pinned chats by hand.
  const pinnedOrder = pinned ? 1 : null;
  patchConversation(chat.chatId, { pinnedOrder });
  try {
    await updateChatSettings(chat.chatId, { pinnedOrder });
  } catch (err) {
    patchConversation(chat.chatId, { pinnedOrder: pinned ? null : chat.pinnedOrder });
    throw err;
  }
}

// ─── Drafts ───────────────────────────────────────────────

/**
 * Persists a draft. Cloud chats sync so the half-written message follows you
 * between devices; secret chats keep it in memory only, because a draft is
 * plaintext and syncing one would hand the server the content the chat exists
 * to protect.
 */
export async function saveDraftFor(chat, body) {
  if (!chat?.chatId) return;

  if (!capabilities({ mode: chat.mode }).isCloud) {
    if (body.trim()) localDrafts.set(chat.chatId, body);
    else localDrafts.delete(chat.chatId);
    return;
  }

  try {
    await apiSaveDraft(chat.chatId, body);
  } catch (err) {
    // A failed draft save must never interrupt typing.
    console.error('Failed to save draft:', err);
  }
}

export function localDraftFor(chatId) {
  return localDrafts.get(chatId) || '';
}

/** Loads synced drafts and attaches them to the chat list. */
export async function hydrateDrafts() {
  try {
    const { drafts } = await fetchDrafts();
    conversations.update((cs) => {
      for (const draft of drafts) {
        const conv = cs.find((c) => c.chatId === draft.chatId);
        if (conv) conv.draft = draft.body;
      }
      return [...cs];
    });
  } catch (err) {
    console.error('Failed to load drafts:', err);
  }
}

export function draftFor(chat) {
  if (!chat?.chatId) return '';
  if (!capabilities({ mode: chat.mode }).isCloud) return localDraftFor(chat.chatId);
  const conv = get(conversations).find((c) => c.chatId === chat.chatId);
  return conv?.draft || '';
}

// ─── Blocking ─────────────────────────────────────────────

// Set of user ids this account has blocked. Loaded once at startup and kept
// in sync locally, so every chat header can answer "is this person blocked?"
// without a request per conversation.
export const blockedUsers = writable(new Set());

export async function hydrateBlocked() {
  try {
    const { blocked } = await fetchBlocked();
    blockedUsers.set(new Set(blocked.map((u) => u.id)));
  } catch (err) {
    console.error('Failed to load blocked users:', err);
  }
}

export function isBlocked(userId) {
  return get(blockedUsers).has(userId);
}

/** Blocks or unblocks, updating the local set optimistically. */
export async function toggleBlock(userId) {
  const currentlyBlocked = isBlocked(userId);

  blockedUsers.update((set) => {
    const next = new Set(set);
    if (currentlyBlocked) next.delete(userId);
    else next.add(userId);
    return next;
  });

  try {
    if (currentlyBlocked) await unblockUser(userId);
    else await blockUser(userId);
    return !currentlyBlocked;
  } catch (err) {
    // Put it back: a UI claiming someone is blocked when the server disagrees
    // is worse than an error, because the user stops expecting messages.
    blockedUsers.update((set) => {
      const next = new Set(set);
      if (currentlyBlocked) next.add(userId);
      else next.delete(userId);
      return next;
    });
    throw err;
  }
}

// ─── Presence ─────────────────────────────────────────────

/**
 * Refreshes presence for the given users.
 *
 * Deliberately only called for people currently on screen. Polling presence
 * for every contact is how a chat app ends up making a request per second per
 * user for information nobody is looking at.
 */
export async function refreshPresence(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;

  try {
    const { presence: rows } = await fetchPresence(ids);
    presence.update((map) => {
      for (const row of rows) {
        map.set(row.userId, { online: row.online, lastSeenAt: row.lastSeenAt });
      }
      return new Map(map);
    });
  } catch (err) {
    console.error('Failed to fetch presence:', err);
  }
}

export function describePresence(entry) {
  if (!entry) return '';
  if (entry.online) return 'online';
  if (!entry.lastSeenAt) return '';

  const seconds = Math.floor((Date.now() - new Date(entry.lastSeenAt)) / 1000);
  if (seconds < 60) return 'last seen just now';
  if (seconds < 3600) return `last seen ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `last seen ${Math.floor(seconds / 3600)}h ago`;
  return 'last seen a while ago';
}

// ─── Search ───────────────────────────────────────────────

export async function runSearch(query) {
  if (!query || query.trim().length < 2) return { results: [], excludesSecretChats: true };
  return searchMessages(query.trim());
}
