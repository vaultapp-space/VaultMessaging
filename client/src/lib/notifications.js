// ============================================================
// Vault — Desktop Web Notifications
// ============================================================
// Native mobile push (FCM, delivery while the app is backgrounded/killed)
// is a separate, much bigger effort — a server-side integration, not a UI
// pass — and is deliberately out of scope here. This is narrower: while
// the desktop *tab* is simply unfocused (app open, browser in the
// background), nothing told you a message arrived at all. The standard Web
// Notification API covers exactly that gap, and only that gap.

import { Capacitor } from '@capacitor/core';

export function canUseNotifications() {
  return !Capacitor.isNativePlatform() && typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotificationPermission() {
  if (!canUseNotifications() || Notification.permission !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch (err) {
    console.error('Notification permission request failed:', err);
  }
}

/**
 * @param {{ title: string, body?: string, onClick?: () => void }} opts
 */
export function notifyNewMessage({ title, body, onClick }) {
  if (!canUseNotifications() || Notification.permission !== 'granted') return;
  // Only while the tab is actually unfocused — a notification popping up
  // over a conversation the user is already looking at is noise, not
  // information.
  if (!document.hidden) return;

  const notification = new Notification(title, {
    body,
    icon: '/icon-192.png',
    tag: 'vault-message', // collapses rapid messages into one notification instead of stacking a pile
  });
  if (onClick) {
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  }
}
