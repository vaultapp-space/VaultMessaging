// ============================================================
// Vault — Password rotation
// ============================================================
// Changing a password here is not a server operation with a client form in
// front of it. The password is the root of every key the account has: the
// master key stretched from it seals the identity vault, and the server only
// ever holds a one-way derivation of it. So the change has to happen on this
// side, in one piece:
//
//   1. re-derive the old master key and prove it (the server checks the
//      derivation it already stores)
//   2. mint a fresh salt and stretch the new password into a new master key
//   3. reseal the identity vault — the private keys, ratchet sessions and
//      sender keys — under the new master key
//   4. hand the server all three at once
//
// If step 3 were skipped, the account would still log in and every secret
// chat in it would be permanently unreadable. That is why the resealed vault
// is an argument to the request rather than a follow-up call: the server
// writes hash, salt and vault in a single statement or writes none of them.

import { get } from 'svelte/store';

import { toBase64 } from './utils.js';
import {
  deriveMasterKeyBits,
  deriveServerAuthSecret,
  deriveHistoryKey,
} from './keys.js';
import { buildIdentityVault } from './sync.js';
import { changePassword as changePasswordRequest, fetchSalt } from '../api/http.js';
import { vaultMasterKey, historyKey, currentUser } from '../stores/session.js';

/** Matches the minimum enforced at registration. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Rotates the account password.
 *
 * @param {string} currentPassword - the real password, which never leaves here
 * @param {string} newPassword
 * @returns {Promise<{revokedDevices: number}>}
 */
export async function changeAccountPassword(currentPassword, newPassword) {
  const user = get(currentUser);
  if (!user) throw new Error('You are not signed in.');

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (newPassword === currentPassword) {
    throw new Error('New password must be different from the current one.');
  }

  // The old salt has to come from the server rather than from memory: it is
  // what the stored credential was derived with, and a stale copy would fail
  // the check in a way that looks like a wrong password.
  const { salt: currentSalt } = await fetchSalt(user.username);

  const currentMasterBits = await deriveMasterKeyBits(currentPassword, currentSalt);
  const currentAuthSecret = await deriveServerAuthSecret(currentMasterBits);

  // A new salt, not the old one. Reusing it would leave the new master key
  // derivable by anyone who had precomputed against the old salt, which is
  // most of what a compromise-driven password change is trying to undo.
  const newSaltBase64 = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const newMasterBits = await deriveMasterKeyBits(newPassword, newSaltBase64);
  const newMasterKeyBase64 = toBase64(newMasterBits);
  const newAuthSecret = await deriveServerAuthSecret(newMasterBits);

  // Built from what is in memory right now, so nothing in the session is
  // lost across the change — the ratchet state for every open secret chat
  // rides along.
  const resealedVault = await buildIdentityVault(newMasterKeyBase64);
  if (!resealedVault) {
    throw new Error(
      'Your identity keys are not loaded, so the password cannot be changed safely. ' +
      'Reload and sign in again first.'
    );
  }

  const result = await changePasswordRequest({
    currentPassword: currentAuthSecret,
    newPassword: newAuthSecret,
    salt: newSaltBase64,
    encryptedVault: resealedVault,
  });

  // Only after the server has committed. Swapping these in first and then
  // failing the request would leave the session holding keys that no longer
  // match the account.
  vaultMasterKey.set(newMasterKeyBase64);
  historyKey.set(await deriveHistoryKey(newMasterKeyBase64, newSaltBase64));

  return { revokedDevices: result?.revokedDevices ?? 0 };
}
