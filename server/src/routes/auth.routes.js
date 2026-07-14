// ============================================================
// Vault — Auth Routes (Register / Login / Logout)
// Username + password only — zero PII
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH } from '../utils/constants.js';
import config from '../config.js';

// Generates a valid dummy Argon2id hash on startup to prevent timing attacks
let dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhashdummyhashdummy';
hashPassword("dummy_password_for_timing_mitigation").then(h => {
  dummyHash = h;
}).catch(() => {});

async function authRoutes(fastify) {

  // ─── REGISTER ─────────────────────────────────────────────
  fastify.post('/api/auth/register', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password', 'identityKey', 'signedPrekey', 'prekeySig', 'oneTimePrekeys', 'salt'],
        properties: {
          username:       { type: 'string', minLength: MIN_USERNAME_LENGTH, maxLength: MAX_USERNAME_LENGTH, pattern: '^[a-zA-Z0-9_]+$' },
          password:       { type: 'string', minLength: MIN_PASSWORD_LENGTH },
          identityKey:    { type: 'string', maxLength: 1000 },  // base64 public identity key
          signedPrekey:   { type: 'string', maxLength: 500 },  // base64 signed prekey
          prekeySig:      { type: 'string', maxLength: 500 },  // base64 signature
          oneTimePrekeys: { type: 'array', items: { type: 'string', maxLength: 500 }, minItems: 1, maxItems: 100 },
          salt:           { type: 'string', maxLength: 50 },   // base64 salt
          encryptedVault: { type: 'string', maxLength: 50000 },
        },
      },
    },
  }, async (request, reply) => {
    const { username, password, identityKey, signedPrekey, prekeySig, oneTimePrekeys, salt, encryptedVault } = request.body;

    // Check uniqueness
    const existing = await fastify.store.getUserByUsername(username);
    if (existing) {
      return reply.code(409).send({ error: 'Username already taken' });
    }

    // Hash password with argon2id
    const passwordHash = await hashPassword(password);

    // Create user
    const user = await fastify.store.createUser({
      username,
      passwordHash,
      identityKey,
      signedPrekey,
      prekeySig,
      salt,
      encryptedVault,
    });

    // Upload one-time prekeys
    await fastify.store.uploadPrekeys(user.id, oneTimePrekeys);

    // Issue JWT as HTTP-only cookie
    const jti = uuidv4();
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, jti },
      { expiresIn: config.jwtExpiresIn }
    );

    // Create server-side session
    await fastify.store.createSession(jti, user.id);

    reply
      .setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        maxAge: 24 * 60 * 60, // 24h
      })
      .code(201)
      .send({
        id: user.id,
        username: user.username,
        salt: user.salt,
      });
  });

  // ─── LOGIN ────────────────────────────────────────────────
  fastify.post('/api/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body;

    const user = await fastify.store.getUserByUsername(username);
    if (!user) {
      await verifyPassword(dummyHash, password);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    let valid = await verifyPassword(user.password_hash, password);
    let isDecoy = false;
    if (!valid && user.decoy_password_hash) {
      valid = await verifyPassword(user.decoy_password_hash, password);
      isDecoy = true;
    }

    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const jti = uuidv4();
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, jti },
      { expiresIn: config.jwtExpiresIn }
    );

    await fastify.store.createSession(jti, user.id);

    reply
      .setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        maxAge: 24 * 60 * 60,
      })
      .send({
        id: user.id,
        username: user.username,
        encryptedVault: isDecoy ? (user.decoy_encrypted_vault || null) : (user.encrypted_vault || null),
        salt: user.salt,
        isDecoy
      });
  });

  // ─── SAVE ENCRYPTED VAULT ──────────────────────────────────
  fastify.post('/api/auth/vault', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['encryptedVault'],
        properties: {
          encryptedVault: { type: 'string', maxLength: 100000 }
        }
      }
    }
  }, async (request, reply) => {
    const isDecoy = request.headers['x-vault-decoy'] === 'true';
    if (isDecoy) {
      await fastify.store.setDecoyVaultOnly(request.user.id, request.body.encryptedVault);
    } else {
      await fastify.store.setEncryptedVault(request.user.id, request.body.encryptedVault);
    }
    return reply.send({ success: true });
  });

  // ─── REGISTER DECOY VAULT ──────────────────────────────────
  fastify.post('/api/auth/decoy-vault', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['decoyPassword', 'decoyEncryptedVault'],
        properties: {
          decoyPassword: { type: 'string', minLength: 8 },
          decoyEncryptedVault: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { decoyPassword, decoyEncryptedVault } = request.body;
    const decoyPasswordHash = await hashPassword(decoyPassword);
    
    await fastify.store.setDecoyVault(request.user.id, decoyPasswordHash, decoyEncryptedVault);
    return reply.send({ success: true });
  });

  // ─── LOGOUT ───────────────────────────────────────────────
  fastify.post('/api/auth/logout', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    // Destroy server-side session
    await fastify.store.deleteSession(request.user.jti);

    reply
      .clearCookie(config.cookieName, { path: '/' })
      .send({ ok: true });
  });

  // ─── WHO AM I (session check on reload) ───────────────────
  fastify.get('/api/auth/me', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const user = await fastify.store.getUserById(request.user.id);
    return {
      id: request.user.id,
      username: request.user.username,
      encryptedVault: user ? user.encrypted_vault : null,
      salt: user ? user.salt : null
    };
  });

  // ─── GET SALT FOR USER ─────────────────────────────────────
  fastify.get('/api/auth/salt/:username', {
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { username } = request.params;
    const user = await fastify.store.getUserByUsername(username);
    if (user) {
      return { salt: user.salt };
    }
    // Return a dummy deterministic salt for non-existent users
    const dummySalt = fastify.store.getDummySalt(username);
    return { salt: dummySalt };
  });

  // ─── CLIENT DEBUG LOG ──────────────────────────────────────
  fastify.post('/api/debug/log', async (request, reply) => {
    const { message, error, context } = request.body;
    fastify.log.error({ clientMessage: message, clientError: error, clientContext: context }, 'Client-side error log received');
    return { ok: true };
  });

  // ─── TRANSIENT SYNC RELAY (QR Code Multi-device sync) ──────
  const syncSessions = new Map();

  fastify.post('/api/auth/sync/initiate', async (request, reply) => {
    const { syncId, payload } = request.body;
    syncSessions.set(syncId, { payload, createdAt: Date.now() });
    
    // Auto-delete after 2 minutes
    setTimeout(() => {
      syncSessions.delete(syncId);
    }, 120000);
    
    return { success: true };
  });

  fastify.get('/api/auth/sync/retrieve/:syncId', async (request, reply) => {
    const { syncId } = request.params;
    const session = syncSessions.get(syncId);
    if (!session) {
      return reply.code(404).send({ error: 'Sync session not found or expired' });
    }
    syncSessions.delete(syncId);
    return { payload: session.payload };
  });
}

export default authRoutes;
