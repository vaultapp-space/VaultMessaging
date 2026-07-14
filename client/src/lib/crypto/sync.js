// ============================================================
// Vault — Cloud Vault Sync Manager
// Serializes and backs up active crypto sessions to cloud.
// ============================================================

import { get } from 'svelte/store';
import { identityKeyPair, signedPrekeyPair, localBackupKey, localBackupPassphrase, loginPassword, ratchetSessions, groupSenderKeys } from '../stores/session.js';
import { saveEncryptedVault } from '../api/http.js';
import { encryptIdentityVault } from './keys.js';

export async function syncCloudVault() {
  try {
    const password = get(loginPassword);
    const ikp = get(identityKeyPair);
    const spk = get(signedPrekeyPair);
    if (!password || !ikp || !spk) return;

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

    const vault = await encryptIdentityVault({
      identityKeyPair: ikp,
      signedPrekeyPair: spk,
      localBackupKeyBase64,
      localBackupPassphrase: get(localBackupPassphrase),
      ratchetSessions: serializedRatchets,
      groupSenderKeys: serializedGroupKeys
    }, password);

    await saveEncryptedVault(vault);
    console.log('[Sync] Cloud vault successfully updated.');
  } catch (err) {
    console.error('[Sync] Failed to backup cloud vault:', err);
  }
}
