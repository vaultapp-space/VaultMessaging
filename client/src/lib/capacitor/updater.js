// ============================================================
// Vault — content OTA updates (Android only)
// ============================================================
// @capgo/capacitor-updater's own docs say isAutoUpdateAvailable() returns
// false the moment a custom updateUrl is configured — a self-hosted server
// "may not support all auto-update features" of their native pipeline. So
// this drives the officially-documented manual-mode sequence explicitly
// (getLatest -> download -> next) rather than trusting autoUpdate config to
// do it silently. capacitor.config.ts sets autoUpdate: false for the same
// reason.
//
// next() queues the downloaded bundle for the *next* natural reload rather
// than swapping it in mid-session — someone mid-conversation should not have
// the JS context torn out from under them.
export async function initCapacitorUpdater() {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

  // The rollback safety net: if this isn't called within the configured
  // appReadyTimeout, the plugin assumes the current bundle is broken and
  // reverts to the last-known-good one on the next launch. Call it first,
  // unconditionally, before anything that could throw — a failed update
  // check must never suppress the one call that makes a bad update
  // recoverable.
  await CapacitorUpdater.notifyAppReady();

  try {
    const latest = await CapacitorUpdater.getLatest();

    // The self-hosted manifest (deploy/scripts/publish-ota.sh) answers
    // "nothing new" with an explicit {error, kind: 'up_to_date'} shape, per
    // the plugin's own contract (see makeJsonRequest in its Android source —
    // any response carrying `error` or `kind` is treated as a non-update,
    // not a value worth throwing on). A missing url is the same thing by a
    // different route.
    if (latest.error || latest.kind || !latest.url) return;

    const bundle = await CapacitorUpdater.download({
      url: latest.url,
      version: latest.version,
      checksum: latest.checksum,
    });
    await CapacitorUpdater.next({ id: bundle.id });
  } catch (err) {
    // A stale bundle is a far better failure mode than a fatal boot error —
    // the app already loaded and is usable, so this is worth logging, not
    // throwing.
    console.warn('[ota] update check failed', err);
  }
}
