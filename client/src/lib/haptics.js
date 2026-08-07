// ============================================================
// Vault — Haptic Feedback
// ============================================================
// Thin wrapper so call sites don't each need the native-platform guard or
// the dynamic import. No-ops entirely on web/desktop.

import { Capacitor } from '@capacitor/core';

async function run(fn) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const mod = await import('@capacitor/haptics');
    await fn(mod);
  } catch {
    // Best-effort — a missing/failed haptic should never block the action
    // it's attached to.
  }
}

/** Light tap — reactions, message sent. */
export function hapticLight() {
  return run(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }));
}

/** Firmer tap — call connect/hangup. */
export function hapticMedium() {
  return run(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Medium }));
}

/** Success buzz pattern — confirmations. */
export function hapticSuccess() {
  return run(({ Haptics, NotificationType }) => Haptics.notification({ type: NotificationType.Success }));
}

/** Error buzz pattern — failures. */
export function hapticError() {
  return run(({ Haptics, NotificationType }) => Haptics.notification({ type: NotificationType.Error }));
}
