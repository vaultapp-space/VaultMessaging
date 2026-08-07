// ============================================================
// Vault — Biometric Vault Unlock (shared enroll/revoke helpers)
// ============================================================
// Two callers need identical enroll/revoke logic: the toggle in Settings
// (ChatSidebar.svelte) and the one-time nudge shown after login/register/
// resume (BiometricPrompt.svelte). Kept here once instead of duplicated.

import { registerBiometric } from './crypto/webauthn.js';
import { encrypt } from './crypto/keys.js';

export function isBiometricEnabled(userId) {
  return localStorage.getItem(`vault_bio_enabled_${userId}`) === 'true';
}

/**
 * Enroll this device's platform biometric for a user, and — if a live vault
 * master key is available — wrap and store it locally so a future app
 * launch can unlock without the password (see Auth.svelte's resume flow).
 * @param {{id: string, username: string, salt: string}} user
 * @param {string|null} masterKeyBase64 - null when there's genuinely nothing
 *   to wrap yet (shouldn't happen in practice: both callers only run this
 *   while already inside an unlocked session).
 * @returns {Promise<{credentialId: string, prfKey: CryptoKey}>}
 */
export async function enableBiometric(user, masterKeyBase64) {
  const result = await registerBiometric(user.username, user.salt);
  localStorage.setItem(`vault_bio_enabled_${user.id}`, 'true');
  localStorage.setItem(`vault_bio_cred_id_${user.id}`, result.credentialId);

  if (masterKeyBase64) {
    const wrapped = await encrypt(result.prfKey, masterKeyBase64);
    localStorage.setItem(`vault_bio_wrapped_master_${user.id}`, JSON.stringify(wrapped));
  }

  return result;
}

export function disableBiometric(userId) {
  localStorage.removeItem(`vault_bio_enabled_${userId}`);
  localStorage.removeItem(`vault_bio_cred_id_${userId}`);
  localStorage.removeItem(`vault_bio_wrapped_master_${userId}`);
}
