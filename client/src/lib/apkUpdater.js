// ============================================================
// Vault — Direct-APK Update Check
// ============================================================
// F-Droid and Obtainium installs already auto-update through their own
// mechanisms; this exists for the third install path (a bare APK download
// with nothing tracking it) which otherwise never learns a new version
// exists at all. Deliberately NOT a full self-updater: no download-and-
// install-in-the-background, no REQUEST_INSTALL_PACKAGES permission, no
// custom native code. It checks the already-public repo index and, if the
// user chooses to act on it, hands off to the system browser — which
// downloads the APK through Android's own Download Manager and surfaces
// the standard "tap to install" notification, identical to what happens
// today when someone manually downloads the APK from the landing page.
// That's a deliberate choice: this app's own history includes removing a
// prior in-app auto-updater specifically over F-Droid's policy against an
// app installing code through anything other than F-Droid's own update
// flow (see the "remove the OTA updater" commit) — this doesn't reproduce
// that, since Vault itself never downloads or installs anything; it only
// ever points the system browser at a URL, the same as a plain hyperlink.

import { Capacitor } from '@capacitor/core';

const REPO_INDEX_URL = 'https://vaultapp.space/fdroid/repo/index-v1.json';
const PACKAGE_ID = 'space.vaultapp.messenger';

/**
 * @returns {Promise<{versionName: string, versionCode: number, downloadUrl: string} | null>}
 */
export async function checkForUpdate() {
  if (!Capacitor.isNativePlatform()) return null;

  try {
    // The plugin import and the index fetch don't depend on each other —
    // running them in parallel (instead of awaiting the import first) is
    // what actually moves the check earlier, since the network round-trip
    // is the dominant cost either way.
    const [{ App }, res] = await Promise.all([
      import('@capacitor/app'),
      fetch(REPO_INDEX_URL),
    ]);
    if (!res.ok) return null;
    const info = await App.getInfo();
    const installedCode = parseInt(info.build, 10);
    if (!Number.isFinite(installedCode)) return null;

    const index = await res.json();

    // index-v1's packages arrays are newest-first — confirmed against the
    // live repo, not assumed from the format spec.
    const packages = index?.packages?.[PACKAGE_ID];
    const latest = packages?.[0];
    if (!latest || typeof latest.versionCode !== 'number') return null;

    if (latest.versionCode > installedCode) {
      return {
        versionName: latest.versionName,
        versionCode: latest.versionCode,
        downloadUrl: `https://vaultapp.space/fdroid/repo/${latest.apkName}`,
      };
    }
    return null;
  } catch (err) {
    console.error('Update check failed:', err);
    return null;
  }
}
