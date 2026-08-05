// ============================================================
// Vault — Cloud Vault Sync Manager
// Serializes and backs up active crypto sessions to cloud.
// ============================================================

import { get } from 'svelte/store';
import { identityKeyPair, signedPrekeyPair, localBackupKey, localBackupPassphrase, vaultMasterKey, ratchetSessions, groupSenderKeys } from '../stores/session.js';
import { saveEncryptedVault } from '../api/http.js';
import { encryptIdentityVault } from './keys.js';

/**
 * Seals the current session's key material under `masterKey`.
 *
 * Separated from the upload because password rotation needs the same vault
 * sealed under a *different* key, and sent as part of the change request
 * rather than saved on its own. Two builders would be two chances for one of
 * them to quietly stop including ratchet sessions.
 *
 * @param {string} masterKey - base64 master key to seal under
 * @returns {Promise<string|null>} the encrypted vault, or null if the
 *   session has no identity keys loaded to put in it
 */
export async function buildIdentityVault(masterKey) {
  const ikp = get(identityKeyPair);
  const spk = get(signedPrekeyPair);
  if (!masterKey || !ikp || !spk) return null;

  // Serialize ratchet sessions
  const serializedRatchets = {};
  const sessions = get(ratchetSessions);
  for (const [peerId, session] of sessions.entries()) {
    serializedRatchets[peerId] = await session.serialize();
  }

  // Serialize group sender keys
  const serializedGroupKeys = {};
  const groupKeys = get(groupSenderKeys);
  for (const [key, session] of groupKeys.entries()) {
    serializedGroupKeys[key] = await session.serialize();
  }

  let localBackupKeyBase64 = null;
  const lbk = get(localBackupKey);
  if (lbk) {
    const raw = await crypto.subtle.exportKey('raw', lbk);
    localBackupKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
  }

  return await encryptIdentityVault({
    identityKeyPair: ikp,
    signedPrekeyPair: spk,
    localBackupKeyBase64,
    localBackupPassphrase: get(localBackupPassphrase),
    ratchetSessions: serializedRatchets,
    groupSenderKeys: serializedGroupKeys
  }, masterKey);
}

export async function syncCloudVault() {
  try {
    const vault = await buildIdentityVault(get(vaultMasterKey));
    if (!vault) return;

    await saveEncryptedVault(vault);
    console.log('[Sync] Cloud vault successfully updated.');
  } catch (err) {
    console.error('[Sync] Failed to backup cloud vault:', err);
  }
}
