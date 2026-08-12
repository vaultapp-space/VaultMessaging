// ============================================================
// Vault — Session Store (In-Memory Only)
// ⚠️ SECTION 0: This store is a Svelte writable backed by NOTHING.
// All state vanishes on tab close / reload.
// ============================================================

import { writable, get } from 'svelte/store';

// ─── Session State ──────────────────────────────────────────

export const currentUser = writable(null);        // { id, username }
export const isLoading = writable(true);           // Initial auth check

// ─── Crypto Key Material (volatile only) ────────────────────
// These NEVER touch any persistence API.

export const identityKeyPair = writable(null);     // CryptoKeyPair
export const signedPrekeyPair = writable(null);    // CryptoKeyPair
export const oneTimePrekeyPairs = writable([]);     // CryptoKeyPair[]
export const historyKey = writable(null);          // CryptoKey
export const localBackupKey = writable(null);          // Cached PBKDF2 CryptoKey
export const localBackupEnabled = writable(false);
export const localBackupPassphrase = writable('');
export const vaultMasterKey = writable('');          // Base64 master key (derived from password) for vault/sync encryption — never the raw password, never sent to the server

// ─── Active Ratchet Sessions ────────────────────────────────
// Map<peerId, RatchetSession>
export const verifiedPeers = writable(new Map()); // Map<peerId, identityKeyBase64>

export const ratchetSessions = writable(new Map());
export const groupSenderKeys = writable(new Map()); // Map<"groupId:senderId", SenderKeySession>
export const groupKeyRecipients = writable(new Map()); // Map<"groupId:senderId", Set<memberId>> — who already has our Sender Key

// ─── UI State ───────────────────────────────────────────────

export const activeView = writable('landing');        // 'landing' | 'auth' | 'chat'
export const activePeer = writable(null);          // { id, username } — currently open chat
export const sidebarOpen = writable(true);

// Which top-level pane the app is showing: the conversation list and its chat,
// or the public feed.
//
// Deliberately NOT a new value in `activeView`. That store switches between
// pre-auth screens and the app, and Chat.svelte — which owns the websocket
// connection, the sync loop and every call handler — lives under its 'chat'
// branch. Adding a sibling branch for the feed would unmount all of that, so
// you would stop receiving calls and messages while scrolling. Thoughts is a
// third pane *inside* Chat.svelte, the same way a channel is.
export const activeSection = writable('chats'); // 'chats' | 'thoughts'

// The post whose thread is open, if any. Null shows the timeline.
export const activeThreadId = writable(null);

// The profile being viewed, by username. Null shows the timeline.
export const activeProfile = writable(null);

// Set when the app is opened via an invite link, so the chat list can open
// the conversation the user just joined rather than dropping them into an
// unexplained list.
export const pendingChatId = writable(null);

// How far this client has caught up in the account's update log. Reconnecting
// asks for everything past it, which is what replaces the old per-message
// `delivered` flag — a boolean that has no single answer once an account has
// more than one device.
export const syncPts = writable(0);

// The channel currently open, if any. Channels are a separate pane from
// conversations rather than a kind of `activePeer`: a channel has
// subscribers instead of members, posts instead of messages, and none of the
// per-peer machinery (ratchets, typing, calls) applies to one.
export const activeChannelId = writable(null);

// Set by the sidebar's "New" menu to open the story composer, which lives in
// Stories.svelte. A store rather than a prop because the two components are
// siblings, not parent and child.
export const composeStoryRequested = writable(false);

export const activeCall = writable(null); // null or { status: 'incoming'|'ongoing', peerId, peerUsername, type, direction, currentCallKey }
export const recentCalls = writable([]);   // call logs

// ─── Helpers ────────────────────────────────────────────────

export function setUser(user) {
  currentUser.set(user);
  isLoading.set(false);
}

export function clearSession() {
  currentUser.set(null);
  identityKeyPair.set(null);
  signedPrekeyPair.set(null);
  oneTimePrekeyPairs.set([]);
  historyKey.set(null);
  localBackupKey.set(null);
  vaultMasterKey.set('');

  // Destroy all ratchet sessions
  const sessions = get(ratchetSessions);
  for (const session of sessions.values()) {
    if (session.destroy) session.destroy();
  }
  ratchetSessions.set(new Map());
  groupSenderKeys.set(new Map());
  groupKeyRecipients.set(new Map());
  verifiedPeers.set(new Map());
  localBackupEnabled.set(false);
  localBackupPassphrase.set('');

  activePeer.set(null);
  activeCall.set(null);
  recentCalls.set([]);

  // Clear message store from volatile memory
  import('./messages.js').then(({ clearMessages }) => {
    clearMessages();
  });

  activeView.set('landing');
}


