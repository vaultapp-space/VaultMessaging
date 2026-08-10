// ============================================================
// Vault — Screenshot / Recents-Thumbnail Blocking (Android)
// ============================================================
// Thin wrapper over the ScreenSecurityPlugin native plugin (FLAG_SECURE).
// No-ops on web, where there is no equivalent capability at all — a browser
// page cannot stop the OS screenshotting it, so the setting is hidden there
// rather than offered and silently ignored.
//
// The authoritative copy of this preference is native (SharedPreferences),
// not localStorage: MainActivity has to read it in onCreate, before the
// WebView exists, so the flag is already set for the very first frame. See
// ScreenSecurityPlugin.java. That's why isScreenSecurityEnabled() asks the
// plugin instead of reading a JS-side cache.

import { Capacitor, registerPlugin } from '@capacitor/core';

const ScreenSecurity = registerPlugin('ScreenSecurity');

/** Whether the toggle should be shown at all. Android-only. */
export function isScreenSecuritySupported() {
  return Capacitor.isNativePlatform();
}

/** @returns {Promise<boolean>} */
export async function isScreenSecurityEnabled() {
  if (!isScreenSecuritySupported()) return false;
  try {
    const { enabled } = await ScreenSecurity.isEnabled();
    return Boolean(enabled);
  } catch {
    return false;
  }
}

/**
 * @param {boolean} enabled
 * @returns {Promise<boolean>} the value actually in effect afterwards, so a
 *   caller can resync its toggle rather than showing a state the OS rejected.
 */
export async function setScreenSecurityEnabled(enabled) {
  if (!isScreenSecuritySupported()) return false;
  try {
    await ScreenSecurity.setEnabled({ enabled });
    return enabled;
  } catch (err) {
    console.error('Failed to change screen security:', err);
    return !enabled;
  }
}
