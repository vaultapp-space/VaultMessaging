// ============================================================
// Vault — Web Push Notifications Router (VAPID)
// Handles subscription storage and push notification relays.
// ============================================================

import webpush from 'web-push';
import fp from 'fastify-plugin';

// VAPID keys generated dynamically on startup in volatile memory (Section 0)
const vapidKeys = webpush.generateVAPIDKeys();

webpush.setVapidDetails(
  'mailto:support@vaultapp.space',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

async function pushRoutes(fastify) {


  // ─── GET VAPID PUBLIC KEY ────────────────────────────────
  fastify.get('/api/push/public-key', async (request, reply) => {
    return reply.send({ publicKey: vapidKeys.publicKey });
  });

  // ─── SUBSCRIBE TO PUSH ──────────────────────────────────
  fastify.post('/api/push/subscribe', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['subscription'],
        properties: {
          subscription: {
            type: 'object',
            required: ['endpoint', 'keys'],
            properties: {
              endpoint: { type: 'string' },
              keys: {
                type: 'object',
                required: ['p256dh', 'auth'],
                properties: {
                  p256dh: { type: 'string' },
                  auth: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { subscription } = request.body;
    const userId = request.user.id;

    // Add subscription stringified to database
    await fastify.store.addPushSubscription(userId, JSON.stringify(subscription));
    fastify.log.info({ userId }, 'Push notification subscription registered');
 
    return reply.send({ success: true });
  });

  fastify.decorate('sendPushNotification', async (userId, payloadObj) => {
    const subscriptions = await fastify.store.getPushSubscriptions(userId);
    if (!subscriptions || subscriptions.size === 0) return;

    const payload = JSON.stringify(payloadObj);

    for (const subStr of subscriptions) {
      const sub = JSON.parse(subStr);
      try {
        fastify.log.info({ endpoint: sub.endpoint }, 'Dispatching E2EE push notification...');
        
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Remove expired or unsubscribed subscription
          await fastify.store.pool.query(
            `DELETE FROM push_subscriptions WHERE subscription = $1`,
            [subStr]
          );
          fastify.log.info({ endpoint: sub.endpoint }, 'Removed expired push subscription');
        } else {
          fastify.log.error(err, 'Failed to dispatch push notification payload');
        }
      }
    }
  });
}

export default fp(pushRoutes);
