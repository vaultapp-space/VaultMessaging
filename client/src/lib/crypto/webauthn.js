// ============================================================
// Vault — WebAuthn PRF Cryptographic Key Derivation
// Enables 100% anonymous local biometric vault unlocking.
// ============================================================

import { deriveAESKey } from './keys.js';
import { fromBase64 } from './utils.js';

/**
 * Check if WebAuthn PRF extension is supported by the browser.
 * @returns {boolean}
 */
export function isPrfSupported() {
  const check = window.PublicKeyCredential &&
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
    typeof window.PublicKeyCredential.prototype.getClientExtensionResults === 'function';
  return !!check;
}

/**
 * Register a platform biometric credential with PRF evaluation.
 * @param {string} username
 * @param {string} saltBase64 - User's unique password salt from server
 * @returns {Promise<{ credentialId: string, prfKey: CryptoKey }>}
 */
export async function registerBiometric(username, saltBase64) {
  if (!isPrfSupported()) {
    throw new Error('WebAuthn PRF extension is not supported by this browser.');
  }

  const rawSalt = fromBase64(saltBase64);
  const prfSalt = new Uint8Array(await crypto.subtle.digest('SHA-256', rawSalt));

  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const options = {
    publicKey: {
      challenge,
      rp: { name: 'Vault Secure Messaging' },
      user: {
        id: userId,
        name: username,
        displayName: `Vault Bio: ${username}`
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        requireResidentKey: true
      },
      extensions: {
        prf: {
          eval: { first: prfSalt }
        }
      },
      timeout: 60000
    }
  };

  const credential = await navigator.credentials.create(options);
  const extensions = credential.getClientExtensionResults();

  if (!extensions.prf || !extensions.prf.enabled) {
    throw new Error('Authenticator did not enable WebAuthn PRF extension.');
  }

  const prfOutputs = extensions.prf.results;
  if (!prfOutputs || !prfOutputs.first) {
    throw new Error('No PRF output generated during credential registration.');
  }

  // Convert raw PRF output (32 bytes) into AES-GCM CryptoKey
  const rawKey = new Uint8Array(prfOutputs.first);
  const aesKey = await deriveAESKey(rawKey, undefined, 'vault-local-backup');

  const credentialIdBase64 = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));

  return {
    credentialId: credentialIdBase64,
    prfKey: aesKey
  };
}

/**
 * Authenticate using platform biometrics and derive the PRF key.
 * @param {string} credentialIdBase64
 * @param {string} saltBase64 - User's unique password salt from server
 * @returns {Promise<CryptoKey>} - Derived AES-GCM vault key
 */
export async function authenticateBiometric(credentialIdBase64, saltBase64) {
  if (!isPrfSupported()) {
    throw new Error('WebAuthn PRF extension is not supported by this browser.');
  }

  const rawSalt = fromBase64(saltBase64);
  const prfSalt = new Uint8Array(await crypto.subtle.digest('SHA-256', rawSalt));

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rawId = new Uint8Array(atob(credentialIdBase64).split('').map(c => c.charCodeAt(0)));

  const options = {
    publicKey: {
      challenge,
      allowCredentials: [{
        type: 'public-key',
        id: rawId
      }],
      userVerification: 'required',
      extensions: {
        prf: {
          eval: { first: prfSalt }
        }
      },
      timeout: 60000
    }
  };

  const assertion = await navigator.credentials.get(options);
  const extensions = assertion.getClientExtensionResults();

  if (!extensions.prf) {
    throw new Error('WebAuthn PRF extension not supported or not activated by device.');
  }

  const prfOutputs = extensions.prf.results;
  if (!prfOutputs || !prfOutputs.first) {
    throw new Error('No PRF output generated during biometric verification.');
  }

  const rawKey = new Uint8Array(prfOutputs.first);
  return await deriveAESKey(rawKey, undefined, 'vault-local-backup');
}
