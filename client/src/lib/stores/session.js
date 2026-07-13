// ============================================================
// Vault — Session Store (In-Memory Only)
// ⚠️ SECTION 0: This store is a Svelte writable backed by NOTHING.
// All state vanishes on tab close / reload.
// ============================================================

import { writable, derived, get } from 'svelte/store';

// ─── Session State ──────────────────────────────────────────

export const currentUser = writable(null);        // { id, username }
export const isAuthenticated = derived(currentUser, $u => $u !== null);
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
export const loginPassword = writable('');          // Volatile login password for cloud vault syncs

// ─── Active Ratchet Sessions ────────────────────────────────
// Map<peerId, RatchetSession>
export const verifiedPeers = writable(new Map()); // Map<peerId, identityKeyBase64>

export const ratchetSessions = writable(new Map());
export const groupSenderKeys = writable(new Map()); // Map<"groupId:senderId", SenderKeySession>

// ─── UI State ───────────────────────────────────────────────

export const activeView = writable('landing');        // 'landing' | 'auth' | 'chat'
export const activePeer = writable(null);          // { id, username } — currently open chat
export const sidebarOpen = writable(true);

export const activeCall = writable(null); // null or { status: 'incoming'|'ongoing', peerId, peerUsername, type, direction, currentCallKey }
export const recentCalls = writable([]);   // call logs

// ─── Helpers ────────────────────────────────────────────────

export function setUser(user) {
  currentUser.set(user);
  activeView.set(user ? 'chat' : 'landing');
  isLoading.set(false);
}

export function clearSession() {
  currentUser.set(null);
  identityKeyPair.set(null);
  signedPrekeyPair.set(null);
  oneTimePrekeyPairs.set([]);
  historyKey.set(null);
  localBackupKey.set(null);
  loginPassword.set('');

  // Destroy all ratchet sessions
  const sessions = get(ratchetSessions);
  for (const session of sessions.values()) {
    if (session.destroy) session.destroy();
  }
  ratchetSessions.set(new Map());
  groupSenderKeys.set(new Map());
  verifiedPeers.set(new Map());
  localBackupEnabled.set(false);
  localBackupPassphrase.set('');

  activePeer.set(null);
  activeCall.set(null);
  recentCalls.set([]);
  activeView.set('landing');
}


