// ============================================================
// Vault — JWT Cookie Authentication Plugin
// HTTP-only, SameSite=Strict JWT stored as cookie
// Satisfies Section 0: cookie jar is browser-managed, not app storage
// ============================================================

import fp from 'fastify-plugin';
import config from '../config.js';

async function authPlugin(fastify) {
  // Register JWT
  await fastify.register(import('@fastify/jwt'), {
    secret: config.jwtSecret,
    cookie: {
      cookieName: config.cookieName,
      signed: false,
    },
  });

  // Decorate with authenticate method
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();

      // Verify session still exists in store AND actually belongs to the
      // user the token claims to be — otherwise a forged token (id: victim,
      // jti: attacker's own valid session) would pass just on jti existing.
      const session = await fastify.store.getSession(request.user.jti);
      if (!session || session.userId !== request.user.id) {
        return reply.code(401).send({ error: 'Session expired' });
      }

      // A revoked device must stop working immediately, not whenever its
      // 24h token happens to expire. Checked here rather than only at
      // sign-out time because the revoking user is on a *different* device:
      // the one being revoked has no idea it happened.
      if (session.deviceId) {
        if (await fastify.store.devices.isRevoked(session.deviceId)) {
          await fastify.store.deleteSession(request.user.jti);
          return reply.code(401).send({ error: 'This device was signed out' });
        }
        request.deviceId = session.deviceId;
      }

      // Touch session last-seen
      await fastify.store.touchSession(request.user.jti);
    } catch (err) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: [],
});
