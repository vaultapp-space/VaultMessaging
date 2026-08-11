// ============================================================
// Vault — Call audio routing
// ============================================================
// Two completely different mechanisms behind one interface.
//
// On the web, output selection is HTMLMediaElement.setSinkId() on the element
// playing the remote stream. On Android there is no such API in the WebView —
// routing is a system-level concern handled by AudioManager, through the
// AudioRoute native plugin. The web path was the only one implemented, which
// is why Android calls came out of a fixed output with the speaker button
// disabled.
//
// Android also needs something the web has no concept of: the device must be
// put into MODE_IN_COMMUNICATION for the duration of a call, or the audio is
// treated as media — wrong volume curve, wrong hardware volume keys, no echo
// cancellation.

import { Capacitor, registerPlugin } from '@capacitor/core';

const AudioRoute = registerPlugin('AudioRoute');

const isNative = () => Capacitor.isNativePlatform();

/** True where the speaker can actually be switched, on either platform. */
export function isSpeakerToggleSupported(mediaElement = null) {
  if (isNative()) return true;
  return Boolean(
    typeof HTMLMediaElement !== 'undefined'
      && 'setSinkId' in HTMLMediaElement.prototype
      && (mediaElement === null || 'setSinkId' in mediaElement)
  );
}

/**
 * Enter/leave call audio mode. Android-only; a no-op on the web, which has no
 * equivalent global state to set.
 *
 * Must be paired — leaving the device in communication mode after a call
 * affects every other app on the phone, not just this one.
 * @param {boolean} inCall
 */
export async function setCallAudioMode(inCall) {
  if (!isNative()) return;
  try {
    await AudioRoute.setInCall({ inCall });
  } catch (err) {
    console.error('Failed to set call audio mode:', err);
  }
}

/**
 * @param {boolean} on true for loudspeaker, false for earpiece/default
 * @param {HTMLMediaElement|null} mediaElement the element playing the remote
 *        stream — used only on the web, where routing is per-element
 * @returns {Promise<boolean>} the state actually in effect afterwards
 */
export async function setSpeakerphone(on, mediaElement = null) {
  if (isNative()) {
    try {
      await AudioRoute.setSpeakerphone({ on });
      return on;
    } catch (err) {
      console.error('Failed to switch speakerphone:', err);
      return !on;
    }
  }

  if (!mediaElement || !('setSinkId' in mediaElement)) return false;
  try {
    if (!on) {
      await mediaElement.setSinkId('default');
      return false;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const speaker = devices.find(
      (d) => d.kind === 'audiooutput' && /speaker/i.test(d.label)
    );
    await mediaElement.setSinkId(speaker ? speaker.deviceId : 'default');
    return true;
  } catch (err) {
    console.error('Failed to switch audio output:', err);
    return false;
  }
}
