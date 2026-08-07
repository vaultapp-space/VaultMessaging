// ============================================================
// Vault — Passphrase Prompt
// ============================================================
// Replaces the four native prompt() calls that were collecting backup/
// identity passphrases — the single most security-sensitive input in the
// app, previously gathered through a plaintext-visible, unvalidated OS
// dialog with no confirm field. Same promise-based pattern as
// lib/stores/confirm.js.

import { writable } from 'svelte/store';

export const passphrasePromptState = writable(null);

/**
 * @param {{ title?: string, message?: string, mode?: 'enter' | 'create', minLength?: number }} opts
 * @returns {Promise<string|null>} the passphrase, or null if cancelled
 */
export function promptPassphrase(opts = {}) {
  return new Promise((resolve) => {
    passphrasePromptState.set({
      title: opts.title || 'Enter Passphrase',
      message: opts.message || '',
      // 'enter' is a single field, unlocking something already encrypted —
      // any length is accepted, since it's whatever was chosen before.
      // 'create' asks twice and enforces a minimum, since a typo here
      // silently locks the backup it protects.
      mode: opts.mode || 'enter',
      minLength: opts.minLength ?? 8,
      resolve: (value) => {
        passphrasePromptState.set(null);
        resolve(value);
      },
    });
  });
}
