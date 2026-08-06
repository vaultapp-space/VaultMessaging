// ============================================================
// Vault — native-shell update check (Android only)
// ============================================================
// Content (JS/CSS/HTML) updates over the air via updater.js. Native-shell
// changes — a new Capacitor plugin, a permission change, an SDK bump — can't:
// they need a freshly signed APK, and there's no Play Store to hand that to
// either (self-hosted distribution, matching Signal's/F-Droid's own model).
// So this just checks a small version manifest on launch and surfaces a
// dismissible banner (UpdateBanner.svelte) pointing at a download — never a
// silent auto-install. No REQUEST_INSTALL_PACKAGES permission, no in-app
// installer intent: tapping through opens the APK URL in the browser and
// lets Android's ordinary download-then-tap-to-install flow (and its
// install-unknown-apps prompt) take over, same as any sideloaded app.
import { writable } from 'svelte/store';

export const nativeUpdateInfo = writable(null); // { versionName, url, notes } | null

function dismissedKey(versionCode) {
  return `vault_android_update_dismissed_${versionCode}`;
}

export function dismissNativeUpdate(versionCode) {
  localStorage.setItem(dismissedKey(versionCode), '1');
  nativeUpdateInfo.set(null);
}

export async function checkForNativeUpdate() {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    // build is the Android versionCode (an incrementing integer, string-
    // typed on the JS side) — the reliable field to compare for "is this
    // newer", unlike version/versionName which is free-form display text.
    const currentBuild = Number(info.build);

    // Under /ota/, not /android/ — the latter would collide with the repo's
    // own top-level android/ source directory on the VPS checkout (nginx's
    // root for this whole server block is the repo root).
    const res = await fetch('https://vaultapp.space/ota/shell-check');
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest?.versionCode || !manifest?.url) return;
    if (manifest.versionCode <= currentBuild) return;

    // Keyed by the specific version seen, not a flat "dismissed" flag — so
    // dismissing this banner doesn't silently suppress a *future*, higher
    // version's banner too.
    if (localStorage.getItem(dismissedKey(manifest.versionCode))) return;

    nativeUpdateInfo.set({
      versionCode: manifest.versionCode,
      versionName: manifest.versionName ?? null,
      url: manifest.url,
      notes: manifest.notes ?? null,
    });
  } catch (err) {
    // A missed update check is not worth interrupting anyone's launch over.
    console.warn('[native-update] check failed', err);
  }
}
