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
