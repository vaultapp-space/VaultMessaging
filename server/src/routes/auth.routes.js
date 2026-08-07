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
          // Self-reported and cosmetic: it only ever labels a row in the
          // owner's own Active Sessions list. Nothing is authorised by it,
          // so a client lying here achieves nothing but a confusing label.
          deviceName:     { type: 'string', maxLength: 64 },
          platform:       { type: 'string', maxLength: 32 },
          appVersion:     { type: 'string', maxLength: 32 },
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

    // Every session belongs to a device, so the account owner can see what
    // is signed in and sign any of it out.
    const device = await fastify.store.devices.register(user.id, {
      name: request.body.deviceName ?? null,
      platform: request.body.platform ?? null,
      appVersion: request.body.appVersion ?? null,
      ip: request.ip ?? null,
    });

    // Issue JWT as HTTP-only cookie
    const jti = uuidv4();
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, jti },
      { expiresIn: config.jwtExpiresIn }
    );

    // Create server-side session
    await fastify.store.createSession(jti, user.id, device.id);

    reply
      .setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        maxAge: config.sessionMaxAgeSeconds,
      })
      .code(201)
      .send({
        id: user.id,
        username: user.username,
        salt: user.salt,
        deviceId: device.id,
        pts: device.pts,
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
          // Self-reported and cosmetic: it only ever labels a row in the
          // owner's own Active Sessions list. Nothing is authorised by it,
          // so a client lying here achieves nothing but a confusing label.
          deviceName:     { type: 'string', maxLength: 64 },
          platform:       { type: 'string', maxLength: 32 },
          appVersion:     { type: 'string', maxLength: 32 },
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

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const device = await fastify.store.devices.register(user.id, {
      name: request.body.deviceName ?? null,
      platform: request.body.platform ?? null,
      appVersion: request.body.appVersion ?? null,
      ip: request.ip ?? null,
    });

    const jti = uuidv4();
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, jti },
      { expiresIn: config.jwtExpiresIn }
    );

    await fastify.store.createSession(jti, user.id, device.id);

    reply
      .setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        maxAge: config.sessionMaxAgeSeconds,
      })
      .send({
        id: user.id,
        username: user.username,
        encryptedVault: user.encrypted_vault || null,
        salt: user.salt,
        deviceId: device.id,
        pts: device.pts,
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
    await fastify.store.setEncryptedVault(request.user.id, request.body.encryptedVault);
    return reply.send({ success: true });
  });

  // ─── LOGOUT ───────────────────────────────────────────────
  fastify.post('/api/auth/logout', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    // Destroy server-side session
    await fastify.store.deleteSession(request.user.jti);

    // Close this device's live socket too — otherwise a tab left open
    // elsewhere keeps receiving real-time traffic on a connection that
    // outlives the session it was authenticated under, identical to the
    // gap this closes for device revocation (devices.routes.js).
    if (request.deviceId) {
      await fastify.fanout.closeUserDeviceSockets(request.user.id, request.deviceId);
    }

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
      salt: user ? user.salt : null,
      deviceId: request.deviceId ?? null,
    };
  });

  // ─── GET SALT FOR USER ─────────────────────────────────────
  fastify.get('/api/auth/salt/:username', {
    config: {
      // Unauthenticated by necessity — a client needs its salt before it can
      // log in. That also makes it the cheapest username-enumeration probe
      // in the app: same rate as login/register keeps guessing at scale
      // impractical, on top of the dummy-salt response already closing the
      // value-based hole.
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
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
  // Intentionally unauthenticated (errors can happen before login), but
  // tightly bounded so it can't be used to flood the server's logs.
  fastify.post('/api/debug/log', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        properties: {
          message: { type: 'string', maxLength: 1000 },
          error:   { type: 'string', maxLength: 2000 },
          context: { type: 'object', additionalProperties: true, maxProperties: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { message, error, context } = request.body;
    // warn, not error. This endpoint is unauthenticated by necessity — the
    // errors worth reporting happen before login — so anyone can write to it.
    // At error level an anonymous caller can bury genuine server faults in
    // noise, which is a cheap way to make an incident harder to read.
    fastify.log.warn({ clientMessage: message, clientError: error, clientContext: context }, 'Client-side error log received');
    return { ok: true };
  });

  // ─── TRANSIENT SYNC RELAY (QR Code Multi-device sync) ──────
  fastify.post('/api/auth/sync/initiate', {
    preValidation: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['syncId', 'payload'],
        properties: {
          syncId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
          payload: { type: 'string', maxLength: 100000 }
        }
      }
    }
  }, async (request, reply) => {
    const { syncId, payload } = request.body;
    await fastify.store.createSyncSession(syncId, payload, request.user.id);
    return { success: true };
  });

  fastify.get('/api/auth/sync/retrieve/:syncId', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
    schema: {
      params: {
        type: 'object',
        required: ['syncId'],
        properties: {
          syncId: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          // Same self-reported/cosmetic device-label fields register/login
          // accept, for the same reason: this device otherwise never gets
          // registered at all, and would be silently unrevokable — see the
          // fix below.
          deviceName: { type: 'string', maxLength: 64 },
          platform:   { type: 'string', maxLength: 32 },
          appVersion: { type: 'string', maxLength: 32 },
        },
      },
    }
  }, async (request, reply) => {
    const { syncId } = request.params;
    const session = await fastify.store.getSyncSession(syncId);
    if (!session) {
      return reply.code(404).send({ error: 'Sync session not found or expired' });
    }
    await fastify.store.deleteSyncSession(syncId);

    const { payload, userId } = session;
    const user = await fastify.store.getUserById(userId);
    if (!user) {
      return reply.code(404).send({ error: 'Account no longer exists' });
    }

    // Registered as a real device — same as register/login — rather than
    // left off the devices table entirely, which is what this endpoint did
    // before: createSession(jti, user.id) with no deviceId meant this
    // device could never appear in Active Sessions, and auth.js's
    // authenticate skips its revocation check whenever session.deviceId is
    // absent, so it could never actually be signed out from another device
    // either.
    const device = await fastify.store.devices.register(user.id, {
      name: request.query.deviceName ?? null,
      platform: request.query.platform ?? null,
      appVersion: request.query.appVersion ?? null,
      ip: request.ip ?? null,
    });

    // Issue a real session for the syncing device, same as register/login,
    // so it isn't left making authenticated API calls with no cookie.
    const jti = uuidv4();
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, jti },
      { expiresIn: config.jwtExpiresIn }
    );
    await fastify.store.createSession(jti, user.id, device.id);

    reply.setCookie(config.cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: config.sessionMaxAgeSeconds,
    });

    return { payload, id: user.id, username: user.username, deviceId: device.id };
  });
}

export default authRoutes;
