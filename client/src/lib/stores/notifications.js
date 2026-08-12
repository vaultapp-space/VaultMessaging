// ============================================================
// Vault — unread notification count
// ============================================================
// A shared store rather than state inside the bell, because the bell lives in
// the Thoughts header and Chats is the view people are actually in. With the
// count owned by the bell, a reply to your post was only discoverable by
// opening the feed and looking — which is the same invisibility the
// notifications feature exists to fix, moved one step out.
//
// The tab bar reads this to show a dot; the bell reads it for its badge. One
// number, so the two can never disagree.

import { writable } from 'svelte/store';

import { fetchNotifications } from '../api/http.js';

export const unreadNotifications = writable(0);

/**
 * Re-reads the count from the server.
 *
 * Always a fetch, never an increment on the socket event. The count is
 * computed with the block filter applied in SQL, and a locally incremented
 * number would drift the moment anything was blocked, expired or read on
 * another device.
 */
export async function refreshUnread() {
  try {
    const { unreadCount } = await fetchNotifications({ limit: 1 });
    unreadNotifications.set(unreadCount);
  } catch {
    // Leave the previous value. A failed poll is not evidence that the count
    // is zero, and showing zero would hide something real.
  }
}

/** Optimistic clear, for when the panel is opened. */
export function clearUnreadLocally() {
  unreadNotifications.set(0);
}
