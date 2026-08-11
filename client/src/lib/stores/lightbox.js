// ============================================================
// Vault — Full-screen media viewer state
// ============================================================
// A single store rather than per-bubble state, for the same reason
// ConfirmDialog and ToastHost are mounted once at the app root: only one
// image can be open at a time, and the viewer has to escape the message
// list's own stacking and overflow-hidden container to cover the screen.
//
// Holds an object URL that MessageBubble already created and owns. The viewer
// deliberately does NOT revoke it on close — the bubble is still rendering
// the same blob as its thumbnail, and revoking would blank it.

import { writable } from 'svelte/store';

/** @type {import('svelte/store').Writable<{src: string, alt: string} | null>} */
export const lightbox = writable(null);

/**
 * @param {string} src object URL of the decrypted image
 * @param {string} alt
 */
export function openLightbox(src, alt = '') {
  lightbox.set({ src, alt });
}

export function closeLightbox() {
  lightbox.set(null);
}

/**
 * Close the viewer if — and only if — it is showing this exact object URL.
 *
 * The bubble owns the blob and revokes it in two places: when a burn-on-read
 * attachment is spent, and when the component is destroyed (the message
 * expired, was deleted, or the conversation was switched). If the viewer is
 * open on that image at the time, revoking leaves it displaying a dead blob:
 * URL — a broken-image icon the user is then staring at full screen, with no
 * indication of why. Worse for the burn-on-read case, where the correct
 * behaviour is for the image to go away, not to become broken.
 *
 * Matching on src rather than closing unconditionally means a viewer showing
 * some *other* image is left alone when an unrelated bubble is destroyed —
 * which happens constantly, since every message in the transcript is a
 * component that can expire.
 *
 * @param {string | null} src
 */
export function closeLightboxFor(src) {
  if (!src) return;
  lightbox.update((current) => (current && current.src === src ? null : current));
}
