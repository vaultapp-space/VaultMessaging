// ============================================================
// Vault — Toast Store
// ============================================================
// Replaces alert() for surfacing errors/confirmations. A native alert()
// blocks the whole WebView behind an OS dialog styled nothing like the
// app — jarring on mobile, and worse, it halts the UI thread it's called
// from. Toasts queue instead, and dismiss themselves.

import { writable } from 'svelte/store';
import { hapticError, hapticSuccess } from '../haptics.js';

export const toasts = writable([]);

let nextId = 1;

// A burst of failures (e.g. several requests failing in a row on a flaky
// connection) would otherwise stack toasts taller than the viewport with
// no way to see or dismiss the ones pushed off-screen. Oldest drops first —
// it's already had its moment on screen.
const MAX_TOASTS = 4;

/**
 * @param {string} message
 * @param {{ type?: 'error' | 'info' | 'success', duration?: number }} [opts]
 */
export function showToast(message, opts = {}) {
  const { type = 'error', duration = 4000 } = opts;
  const id = nextId++;
  toasts.update((list) => [...list, { id, message, type }].slice(-MAX_TOASTS));
  if (type === 'error') hapticError();
  else if (type === 'success') hapticSuccess();
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

export function dismissToast(id) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}
