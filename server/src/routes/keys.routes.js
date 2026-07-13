// ============================================================
// Vault — Key Bundle Routes
// X3DH prekey bundle upload/fetch + replenishment
// ============================================================

import { LOW_PREKEY_THRESHOLD, MAX_PREKEYS_PER_UPLOAD } from '../utils/constants.js';

async function keysRoutes(fastify) {

  // ─── GET PREKEY BUNDLE for a peer ─────────────────────────
  fastify.get('/api/keys/bundle/:username', {
    preValidation: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 10,
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

    // Can't fetch own bundle
    if (username === request.user.username) {
      return reply.code(400).send({ error: 'Cannot fetch own key bundle' });
    }

    const bundle = await fastify.store.getKeyBundle(username);
    if (!bundle) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return bundle;
  });

  // ─── REPLENISH one-time prekeys ───────────────────────────
  fastify.post('/api/keys/replenish', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['prekeys'],
        properties: {
          prekeys: {
            type: 'array',
            items: { type: 'string', maxLength: 500 },
            minItems: 1,
            maxItems: MAX_PREKEYS_PER_UPLOAD,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { prekeys } = request.body;
    await fastify.store.uploadPrekeys(request.user.id, prekeys);
    const remaining = await fastify.store.countUnusedPrekeys(request.user.id);
    return { uploaded: prekeys.length, remaining };
  });

  // ─── CHECK prekey count ───────────────────────────────────
  fastify.get('/api/keys/count', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const count = await fastify.store.countUnusedPrekeys(request.user.id);
    return { count, low: count < LOW_PREKEY_THRESHOLD };
  });

  // ─── UPDATE key bundle ────────────────────────────────────
  fastify.put('/api/keys/update', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['identityKey', 'signedPrekey', 'prekeySig', 'oneTimePrekeys'],
        properties: {
          identityKey:    { type: 'string', maxLength: 1000 },
          signedPrekey:   { type: 'string', maxLength: 500 },
          prekeySig:      { type: 'string', maxLength: 500 },
          oneTimePrekeys: {
            type: 'array',
            items: { type: 'string', maxLength: 500 },
            minItems: 1,
            maxItems: MAX_PREKEYS_PER_UPLOAD,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { identityKey, signedPrekey, prekeySig, oneTimePrekeys } = request.body;
    
    // Check if there are active connections already (Session Collision)
    const activeConns = fastify.store.getConnections(request.user.id);
    if (activeConns && activeConns.size > 0) {
      for (const socket of activeConns) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({
            type: 'session_collision',
            message: 'Session updated from another device. Your keys have been overwritten.'
          }));
        }
      }
    }

    await fastify.store.updateUserKeys(request.user.id, {
      identityKey,
      signedPrekey,
      prekeySig,
    });

    await fastify.store.resetPrekeys(request.user.id, oneTimePrekeys);

    return { status: 'success' };
  });

  // ─── UPDATE signed prekey only ─────────────────────────────
  fastify.put('/api/keys/signed-prekey', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['signedPrekey', 'prekeySig'],
        properties: {
          signedPrekey: { type: 'string', maxLength: 500 },
          prekeySig:    { type: 'string', maxLength: 500 }
        }
      }
    }
  }, async (request, reply) => {
    const { signedPrekey, prekeySig } = request.body;
    
    await fastify.store.updateSignedPrekey(request.user.id, signedPrekey, prekeySig);
    
    return { status: 'success' };
  });
}

export default keysRoutes;
