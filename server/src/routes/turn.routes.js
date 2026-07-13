// ============================================================
// Vault — TURN Credentials Route
// Generates ephemeral HMAC-SHA1 credentials for coturn
// ============================================================

import crypto from 'node:crypto';
import config from '../config.js';

async function turnRoutes(fastify) {

  // ─── GET EPHEMERAL TURN CREDENTIALS ──────────────────────
  fastify.get('/api/turn/credentials', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const ttl = config.turnCredentialTTL;
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    const username = `${timestamp}:${request.user.id}`;

    // HMAC-SHA1 of the username using the shared secret (coturn use-auth-secret mode)
    const hmac = crypto.createHmac('sha1', config.turnSecret);
    hmac.update(username);
    const credential = hmac.digest('base64');

    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: `stun:${config.turnServer}` },
        {
          urls: `turn:${config.turnServer}`,
          username,
          credential
        }
      ],
      ttl
    };
  });
}

export default turnRoutes;
