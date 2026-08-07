// ============================================================
// Vault — Open a URL in the Real External Browser (not Custom Tabs)
// ============================================================
// openExternal.js (@capacitor/browser) is correct for ordinary links —
// Custom Tabs are faster and feel more integrated for just viewing a page.
// This exists for the one case where that's the wrong choice: downloading
// the update APK. Custom Tabs share this app's own task/back-stack rather
// than being a separate browser instance, and have real reliability
// problems completing a large binary download — see
// android/.../ExternalOpenerPlugin.java, the tiny native plugin backing
// this, for the full story. A plain Intent.ACTION_VIEW handoff to whatever
// the user's actual default browser is doesn't have that problem, since
// the download goes through that browser's own normal Download Manager
// integration instead.

import { Capacitor, registerPlugin } from '@capacitor/core';

const ExternalOpener = registerPlugin('ExternalOpener');

export function openInRealBrowser(url) {
  if (!Capacitor.isNativePlatform()) {
    window.open(url, '_blank');
    return;
  }
  ExternalOpener.open({ url }).catch((err) => {
    console.error('ExternalOpener failed, falling back to Browser.open:', err);
    import('@capacitor/browser').then(({ Browser }) => Browser.open({ url }));
  });
}
