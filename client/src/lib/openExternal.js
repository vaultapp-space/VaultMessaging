// ============================================================
// Vault — Open External Links Reliably from the Android WebView
// ============================================================
// A Capacitor WebView doesn't implement multi-tab browsing, so a plain
// `<a target="_blank">` has nowhere reliable to go — it can silently do
// nothing rather than opening a system browser. `@capacitor/browser` is the
// supported way to hand a URL off to one. Web behavior is untouched: the
// anchor's normal target="_blank" handles it there, so this only intercepts
// on native.

import { Capacitor } from '@capacitor/core';

export function openExternal(event, url) {
  if (!Capacitor.isNativePlatform()) return;
  event.preventDefault();
  import('@capacitor/browser')
    .then(({ Browser }) => Browser.open({ url }))
    .catch(() => window.open(url, '_blank'));
}
