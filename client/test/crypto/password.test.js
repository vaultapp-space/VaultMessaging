import { describe, test, expect, vi, beforeEach } from 'vitest';

import {
  generateExportableKeyPair,
  generateSigningKeyPair,
  deriveMasterKeyBits,
  deriveServerAuthSecret,
  decryptIdentityVault,
} from '../../src/lib/crypto/keys.js';
import { toBase64 } from '../../src/lib/crypto/utils.js';

// The network layer is the thing under inspection here: what matters is not
// that a request went out but exactly what was in it. A password change that
// posted the real password, or posted a vault still sealed under the old key,
// would look identical from the UI and be catastrophic in different ways.
const requests = [];
vi.mock('../../src/lib/api/http.js', () => ({
  fetchSalt: vi.fn(async () => ({ salt: OLD_SALT })),
  changePassword: vi.fn(async (payload) => {
    requests.push(payload);
    return { ok: true, revokedDevices: 2 };
  }),
  saveEncryptedVault: vi.fn(async () => ({ success: true })),
}));

const OLD_SALT = toBase64(new Uint8Array(16).fill(7));
const OLD_PASSWORD = 'the-old-password';
const NEW_PASSWORD = 'a-completely-new-password';

const { changeAccountPassword } = await import('../../src/lib/crypto/password.js');
const session = await import('../../src/lib/stores/session.js');

async function signIn() {
  session.currentUser.set({ id: 'u1', username: 'alice' });
  session.identityKeyPair.set({
    ecdh: await generateExportableKeyPair(),
    ecdsa: await generateSigningKeyPair(),
  });
  session.signedPrekeyPair.set(await generateExportableKeyPair());
  session.ratchetSessions.set(new Map());
  session.groupSenderKeys.set(new Map());
  session.localBackupKey.set(null);
  session.localBackupPassphrase.set('');

  const oldMaster = await deriveMasterKeyBits(OLD_PASSWORD, OLD_SALT);
  session.vaultMasterKey.set(toBase64(oldMaster));
}

beforeEach(async () => {
  requests.length = 0;
  await signIn();
});

describe('changeAccountPassword', () => {
  test('sends derived secrets, never either password', async () => {
    await changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD);

    expect(requests).toHaveLength(1);
    const sent = JSON.stringify(requests[0]);
    expect(sent).not.toContain(OLD_PASSWORD);
    expect(sent).not.toContain(NEW_PASSWORD);
  });

  test('proves the old password and commits the new one', async () => {
    await changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD);
    const { currentPassword, newPassword, salt } = requests[0];

    const expectedCurrent = await deriveServerAuthSecret(
      await deriveMasterKeyBits(OLD_PASSWORD, OLD_SALT)
    );
    expect(currentPassword).toBe(expectedCurrent);

    // The new secret has to be derived against the *new* salt that went out
    // in the same request, or the next login derives something else.
    const expectedNew = await deriveServerAuthSecret(
      await deriveMasterKeyBits(NEW_PASSWORD, salt)
    );
    expect(newPassword).toBe(expectedNew);
  });

  test('mints a fresh salt rather than reusing the old one', async () => {
    await changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD);
    expect(requests[0].salt).not.toBe(OLD_SALT);
  });

  test('reseals the vault so it opens under the new master key only', async () => {
    await changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD);
    const { salt, encryptedVault } = requests[0];

    const newMaster = toBase64(await deriveMasterKeyBits(NEW_PASSWORD, salt));
    const opened = await decryptIdentityVault(encryptedVault, newMaster);
    expect(opened.identityKeyPair.ecdh.privateKey).toBeTruthy();

    // The failure this guards against is the one that cannot be undone: a
    // vault still sealed under the old key locks every secret chat forever
    // while the account itself logs in perfectly.
    const oldMaster = toBase64(await deriveMasterKeyBits(OLD_PASSWORD, OLD_SALT));
    await expect(decryptIdentityVault(encryptedVault, oldMaster)).rejects.toThrow();
  });

  test('moves the session to the new master key', async () => {
    const { get } = await import('svelte/store');
    await changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD);

    const expected = toBase64(await deriveMasterKeyBits(NEW_PASSWORD, requests[0].salt));
    expect(get(session.vaultMasterKey)).toBe(expected);
  });

  test('refuses a password that is too short, before any request', async () => {
    await expect(changeAccountPassword(OLD_PASSWORD, 'short')).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  test('refuses a change to the same password', async () => {
    await expect(changeAccountPassword(OLD_PASSWORD, OLD_PASSWORD)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  test('refuses when no identity keys are loaded to reseal', async () => {
    session.identityKeyPair.set(null);
    await expect(changeAccountPassword(OLD_PASSWORD, NEW_PASSWORD)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
