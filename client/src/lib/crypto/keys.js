// ============================================================
// Vault — Web Crypto Key Management
// Keys live in volatile JS memory for the lifetime of a session. They can
// optionally be persisted encrypted-at-rest — via the local IndexedDB
// backup (localBackupKey) or the server-side encrypted cloud vault — but
// in both cases only as ciphertext under a key derived from the user's
// password; the server and disk never see a plaintext private key.
// ============================================================

import { toBase64, fromBase64 } from './utils.js';

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
const AES_PARAMS  = { name: 'AES-GCM', length: 256 };

/**
 * Generate an ECDH key pair (P-256).
 * Private key is NOT extractable — held only in CryptoKey form.
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateKeyPair() {
  return await crypto.subtle.generateKey(
    ECDH_PARAMS,
    false,  // private NOT extractable
    ['deriveKey', 'deriveBits']
  );
}

/**
 * Generate an ECDH key pair with extractable keys (for prekey upload).
 * Only the PUBLIC key is sent to the server.
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateExportableKeyPair() {
  return await crypto.subtle.generateKey(
    ECDH_PARAMS,
    true,  // extractable so we can export public portion
    ['deriveKey', 'deriveBits']
  );
}

/**
 * Export a public key to raw bytes.
 * @param {CryptoKey} publicKey
 * @returns {Promise<Uint8Array>}
 */
export async function exportPublicKey(publicKey) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
}

/**
 * Export a public key to base64 string (for API transmission).
 * @param {CryptoKey} publicKey
 * @returns {Promise<string>}
 */
export async function exportPublicKeyBase64(publicKey) {
  const raw = await exportPublicKey(publicKey);
  return toBase64(raw);
}

/**
 * Import a peer's public key from raw bytes.
 * @param {Uint8Array} rawBytes
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(rawBytes) {
  if (typeof rawBytes === 'string') {
    rawBytes = fromBase64(rawBytes);
  }
  return await crypto.subtle.importKey(
    'raw', rawBytes, ECDH_PARAMS, true, []
  );
}

/**
 * Import a peer's ECDSA public key from raw bytes.
 * @param {Uint8Array|string} rawBytes
 * @returns {Promise<CryptoKey>}
 */
export async function importECDSAPublicKey(rawBytes) {
  if (typeof rawBytes === 'string') {
    rawBytes = fromBase64(rawBytes);
  }
  return await crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/**
 * Perform ECDH key agreement and derive an AES-256-GCM key via HKDF.
 * @param {CryptoKey} privateKey - Our ECDH private key
 * @param {CryptoKey} peerPublicKey - Peer's ECDH public key
 * @param {string} info - Context info for HKDF
 * @returns {Promise<Uint8Array>} - 32 bytes of derived key material
 */
export async function deriveSharedBits(privateKey, peerPublicKey, info = 'vault-e2ee') {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Derive an AES-GCM key from raw key material via HKDF.
 * @param {Uint8Array} ikm - Input key material
 * @param {Uint8Array} salt
 * @param {string} info
 * @returns {Promise<CryptoKey>}
 */
export async function deriveAESKey(ikm, salt = new Uint8Array(32), info = 'vault-aes') {
  const hkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(info),
    },
    hkdfKey,
    AES_PARAMS,
    false,  // derived key NOT extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {CryptoKey} key - AES-GCM key
 * @param {string} plaintext
 * @returns {Promise<{iv: string, ciphertext: string}>} - base64 encoded
 */
export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * @param {CryptoKey} key - AES-GCM key
 * @param {string} ivBase64 - base64 IV
 * @param {string} ciphertextBase64 - base64 ciphertext
 * @returns {Promise<string>} - decrypted plaintext
 */
export async function decrypt(key, ivBase64, ciphertextBase64) {
  const iv = fromBase64(ivBase64);
  const ciphertext = fromBase64(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * HMAC-SHA256 for ratchet chain key derivation.
 * @param {Uint8Array} key
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function hmacSHA256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

/**
 * Wipe key material references.
 * CryptoKey objects are GC'd when dereferenced.
 * Uint8Arrays are zeroed out explicitly.
 */
export function wipeKeyMaterial(...items) {
  for (const item of items) {
    if (item instanceof Uint8Array) {
      item.fill(0);
    }
    // CryptoKey objects: set reference to null in the caller
  }
}

/**
 * Generate N one-time prekey pairs.
 * Returns public keys as base64 (for server upload) and keeps key pairs in memory.
 * @param {number} count
 * @returns {Promise<{publicKeys: string[], keyPairs: CryptoKeyPair[]}>}
 */
export async function generateOneTimePrekeys(count = 20) {
  // Parallelize key generation — all at once instead of sequential
  const keyPairs = await Promise.all(
    Array.from({ length: count }, () => generateExportableKeyPair())
  );
  const publicKeys = await Promise.all(
    keyPairs.map(kp => exportPublicKeyBase64(kp.publicKey))
  );
  return { publicKeys, keyPairs };
}

/**
 * Sign data with ECDSA (for prekey signatures).
 * Uses the identity key to sign the signed prekey.
 */
export async function generateSigningKeyPair() {
  return await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
}

export async function signData(privateKey, data) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    data
  );
  return new Uint8Array(signature);
}

/**
 * Derive a strong 256-bit master key from the user's real password via
 * PBKDF2. This is the ONE place the real password is stretched; everywhere
 * else in the app (vault encryption, sync payloads, server authentication)
 * derives from this master key rather than the password directly, so that
 * no single derived value sent elsewhere (especially the server) is enough
 * to reconstruct any of the others.
 */
export async function deriveMasterKeyBits(password, saltBase64) {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const salt = fromBase64(saltBase64);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    passwordKey,
    256
  );
  return new Uint8Array(bits);
}

/**
 * One-way derivation of the value sent to the server for authentication.
 * The server (and anyone who compromises it) only ever sees this — it
 * cannot be reversed back into masterKeyBits, so it can't be used to
 * decrypt the vault, sync payloads, or anything else derived from the
 * master key.
 */
export async function deriveServerAuthSecret(masterKeyBits) {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    masterKeyBits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode('vault-server-auth-v1'));
  return toBase64(new Uint8Array(sig));
}

/**
 * Derive a history encryption key from username and password using PBKDF2.
 */
export async function deriveHistoryKey(password, saltBase64) {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  const salt = fromBase64(saltBase64);
  
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptFile(arrayBuffer) {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    arrayBuffer
  );

  const exportedKey = await crypto.subtle.exportKey('raw', key);
  const exportedKeyArray = new Uint8Array(exportedKey);
  const encryptedArray = new Uint8Array(encrypted);

  const res = {
    keyBase64: toBase64(exportedKeyArray),
    ivBase64: toBase64(iv),
    ciphertextBase64: toBase64(encryptedArray)
  };

  // Zero-out transient private key material and IV buffers immediately
  exportedKeyArray.fill(0);
  iv.fill(0);

  return res;
}

/**
 * Decrypt file base64 ciphertext using key and iv base64 values.
 */
export async function decryptFile(ciphertextBase64, keyBase64, ivBase64) {
  const ciphertext = fromBase64(ciphertextBase64);
  const iv = fromBase64(ivBase64);
  const rawKey = fromBase64(keyBase64);

  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    'AES-GCM',
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  // Zero-out transient key buffer, IV, and ciphertext to protect browser memory
  rawKey.fill(0);
  iv.fill(0);
  ciphertext.fill(0);

  return decrypted;
}

let dbSalt = null;

/**
 * Encrypt data string using a password-derived key (PBKDF2 + AES-GCM) or a cached key.
 */
export async function encryptLocalDB(plaintext, passphrase, cachedKey = null) {
  const encoder = new TextEncoder();
  let salt;
  if (cachedKey && dbSalt) {
    salt = dbSalt;
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    dbSalt = salt;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));

  let key = cachedKey;
  if (!key) {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      true, // keep extractable/cacheable in memory
      ['encrypt', 'decrypt']
    );
  }

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );

  return {
    encryptedJson: JSON.stringify({
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted))
    }),
    derivedKey: key
  };
}

/**
 * Decrypt local database payload using the passphrase or a cached key.
 */
export async function decryptLocalDB(encryptedJson, passphrase, cachedKey = null) {
  const { salt, iv, ciphertext } = JSON.parse(encryptedJson);
  const encoder = new TextEncoder();

  let key = cachedKey;
  if (!key) {
    const parsedSalt = fromBase64(salt);
    dbSalt = parsedSalt;

    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: parsedSalt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      true, // keep extractable/cacheable in memory
      ['encrypt', 'decrypt']
    );
  } else {
    dbSalt = fromBase64(salt);
  }

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );

  return {
    decryptedText: new TextDecoder().decode(decrypted),
    derivedKey: key
  };
}

/**
 * Export identity keys as a passphrase-encrypted JWK JSON package.
 */
export async function exportIdentityBackup(identityKeys, ecdsaKeys, passphrase) {
  const dhPrivateJwk = await crypto.subtle.exportKey('jwk', identityKeys.privateKey);
  const dhPublicJwk = await crypto.subtle.exportKey('jwk', identityKeys.publicKey);
  const ecdsaPrivateJwk = await crypto.subtle.exportKey('jwk', ecdsaKeys.privateKey);
  const ecdsaPublicJwk = await crypto.subtle.exportKey('jwk', ecdsaKeys.publicKey);

  const payload = JSON.stringify({
    dhPrivateJwk,
    dhPublicJwk,
    ecdsaPrivateJwk,
    ecdsaPublicJwk
  });

  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(payload)
  );

  return JSON.stringify({
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted))
  });
}

/**
 * Decrypt and import identity keys from a passphrase-encrypted JWK JSON package.
 */
export async function importIdentityBackup(encryptedJson, passphrase) {
  const { salt, iv, ciphertext } = JSON.parse(encryptedJson);
  const encoder = new TextEncoder();

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );

  const payload = JSON.parse(new TextDecoder().decode(decrypted));

  const dhPrivateKey = await crypto.subtle.importKey(
    'jwk',
    payload.dhPrivateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );

  const dhPublicKey = await crypto.subtle.importKey(
    'jwk',
    payload.dhPublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );

  const ecdsaPrivateKey = await crypto.subtle.importKey(
    'jwk',
    payload.ecdsaPrivateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );

  const ecdsaPublicKey = await crypto.subtle.importKey(
    'jwk',
    payload.ecdsaPublicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );

  return {
    dh: { publicKey: dhPublicKey, privateKey: dhPrivateKey },
    ecdsa: { publicKey: ecdsaPublicKey, privateKey: ecdsaPrivateKey }
  };
}

/**
 * Encrypt a file chunk using AES-256-GCM.
 * @param {CryptoKey} key
 * @param {ArrayBuffer} arrayBuffer
 * @param {number} chunkIndex
 * @param {Uint8Array} baseIv - 12-byte base IV
 * @returns {Promise<Uint8Array>}
 */
export async function encryptChunk(key, arrayBuffer, chunkIndex, baseIv) {
  const iv = new Uint8Array(baseIv);
  const view = new DataView(iv.buffer);
  view.setUint32(8, chunkIndex, false); // big endian

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    arrayBuffer
  );
  return new Uint8Array(encrypted);
}

/**
 * Decrypt a file chunk using AES-256-GCM.
 * @param {CryptoKey} key
 * @param {Uint8Array} encryptedBuffer
 * @param {number} chunkIndex
 * @param {Uint8Array} baseIv - 12-byte base IV
 * @returns {Promise<ArrayBuffer>}
 */
export async function decryptChunk(key, encryptedBuffer, chunkIndex, baseIv) {
  const iv = new Uint8Array(baseIv);
  const view = new DataView(iv.buffer);
  view.setUint32(8, chunkIndex, false);

  return await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encryptedBuffer
  );
}



/**
 * Encrypt the entire identity vault configuration using password-derived key.
 */
export async function encryptIdentityVault(vaultObj, passphrase) {
  // Export identity keys to JWKs
  const dhPrivateJwk = await crypto.subtle.exportKey('jwk', vaultObj.identityKeyPair.ecdh.privateKey);
  const dhPublicJwk = await crypto.subtle.exportKey('jwk', vaultObj.identityKeyPair.ecdh.publicKey);
  const ecdsaPrivateJwk = await crypto.subtle.exportKey('jwk', vaultObj.identityKeyPair.ecdsa.privateKey);
  const ecdsaPublicJwk = await crypto.subtle.exportKey('jwk', vaultObj.identityKeyPair.ecdsa.publicKey);

  // Export signed prekey to JWKs
  const spkPrivateJwk = await crypto.subtle.exportKey('jwk', vaultObj.signedPrekeyPair.privateKey);
  const spkPublicJwk = await crypto.subtle.exportKey('jwk', vaultObj.signedPrekeyPair.publicKey);

  const payload = JSON.stringify({
    dhPrivateJwk,
    dhPublicJwk,
    ecdsaPrivateJwk,
    ecdsaPublicJwk,
    spkPrivateJwk,
    spkPublicJwk,
    localBackupKeyBase64: vaultObj.localBackupKeyBase64,
    localBackupPassphrase: vaultObj.localBackupPassphrase,
    ratchetSessions: vaultObj.ratchetSessions || null,
    groupSenderKeys: vaultObj.groupSenderKeys || null
  });

  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(payload)
  );

  return JSON.stringify({
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted))
  });
}

/**
 * Decrypt the identity vault configuration using password-derived key.
 */
export async function decryptIdentityVault(encryptedJson, passphrase) {
  const { salt, iv, ciphertext } = JSON.parse(encryptedJson);
  const encoder = new TextEncoder();

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );

  const payload = JSON.parse(new TextDecoder().decode(decrypted));

  // Import ECDH identity key pair
  const ecdhPrivate = await crypto.subtle.importKey('jwk', payload.dhPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const ecdhPublic = await crypto.subtle.importKey('jwk', payload.dhPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

  // Import ECDSA identity key pair
  const ecdsaPrivate = await crypto.subtle.importKey('jwk', payload.ecdsaPrivateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const ecdsaPublic = await crypto.subtle.importKey('jwk', payload.ecdsaPublicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);

  // Import Signed Prekey
  const spkPrivate = await crypto.subtle.importKey('jwk', payload.spkPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const spkPublic = await crypto.subtle.importKey('jwk', payload.spkPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);

  return {
    identityKeyPair: {
      ecdh: { privateKey: ecdhPrivate, publicKey: ecdhPublic },
      ecdsa: { privateKey: ecdsaPrivate, publicKey: ecdsaPublic }
    },
    signedPrekeyPair: { privateKey: spkPrivate, publicKey: spkPublic },
    localBackupKeyBase64: payload.localBackupKeyBase64,
    localBackupPassphrase: payload.localBackupPassphrase,
    ratchetSessions: payload.ratchetSessions || null,
    groupSenderKeys: payload.groupSenderKeys || null
  };
}

export async function importStaticKey(rawBytes) {
  return await crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSyncPayload(payloadObj, aesKeyRawBytes) {
  const aesKey = await importStaticKey(aesKeyRawBytes);
  const plaintext = JSON.stringify(payloadObj);
  const { iv, ciphertext } = await encrypt(aesKey, plaintext);
  return JSON.stringify({ iv, ciphertext });
}

export async function decryptSyncPayload(encryptedJsonStr, aesKeyRawBytes) {
  const aesKey = await importStaticKey(aesKeyRawBytes);
  const { iv, ciphertext } = JSON.parse(encryptedJsonStr);
  const plaintext = await decrypt(aesKey, iv, ciphertext);
  return JSON.parse(plaintext);
}

