// ============================================================
// Vault — In-App Confirm Dialog
// ============================================================
// Replaces native confirm() the same way toast.js replaced alert() — an
// unstyled OS dialog clashing with the rest of the app, and on mobile,
// blocking the whole WebView thread it's called from.
//
// Two-button mode (the common case) resolves a boolean, a drop-in
// replacement for `if (!confirm(...)) return;`:
//   if (!(await showConfirm('Delete this folder?'))) return;
//
// Three-button mode (pass neutralLabel) resolves 'confirm' | 'neutral' |
// 'cancel' — for choices like the message-delete flow, which isn't really
// a yes/no question ("delete for everyone" vs "delete for me" vs "don't
// delete" are three distinct outcomes, not a confirm/abort of one action).

import { writable } from 'svelte/store';

export const confirmState = writable(null);

export function showConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const isThreeButton = Boolean(opts.neutralLabel);
    confirmState.set({
      message,
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel: opts.cancelLabel || 'Cancel',
      neutralLabel: opts.neutralLabel || null,
      danger: opts.danger ?? true,
      resolve: (result) => {
        confirmState.set(null);
        resolve(isThreeButton ? result : result === 'confirm');
      },
    });
  });
}
