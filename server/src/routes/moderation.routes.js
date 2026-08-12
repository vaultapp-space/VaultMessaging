// ============================================================
// Vault — Moderation
// ============================================================
// The operator surface for Thoughts. Deliberately small.
//
// The posture this implements is "nothing is removed for being disagreeable,
// only for being illegal", so there is no approve/reject/warn workflow here —
// only a queue, a takedown, and the ability to stop an account posting. Every
// affordance beyond that would be an invitation to use it.
//
// **Authorization is `users.is_operator`, and that is a privilege bit on a
// table anyone can create rows in.** Any code path that can UPDATE users can
// grant it, which an environment variable could not. Three things narrow that:
// the surface is these three routes, they 404 rather than 403 so a
// non-operator cannot even confirm the endpoints exist, and every action here
// is also available offline via scripts/moderation.js — so if the HTTP surface
// ever looks like a liability it can be deleted without losing the capability.
//
// Nothing in the application writes is_operator. It is granted by hand in SQL.

import { UUID_PATTERN } from '../utils/constants.js';

const idParam = { type: 'string', pattern: UUID_PATTERN };

async function moderationRoutes(fastify) {

  // 404, never 403. A 403 confirms the route exists and that operators are a
  // thing, which is the first step in looking for a way to become one.
  async function requireOperator(request, reply) {
    if (!(await fastify.repos.posts.isOperator(request.user.id))) {
      reply.code(404).send({ error: 'Not found' });
      return false;
    }
    return true;
  }

  // ─── QUEUE ────────────────────────────────────────────────
  fastify.get('/api/moderation/reports', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
    },
  }, async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;

    // Grouped by post: ten reports on one thing is one row to read, not ten.
    // The operator's attention is the scarce resource, and a queue that is
    // tedious to read is a queue that goes unread.
    const reports = await fastify.repos.posts.reportQueue({ limit: request.query.limit });
    return reply.send({
      reports,
      // Said out loud because it changes how the queue should be worked: the
      // reports table cascades from posts, which expire, so anything not
      // actioned within a day resolves itself by deletion.
      retentionSeconds: fastify.repos.posts.ttlSeconds,
    });
  });

  // ─── TAKEDOWN ─────────────────────────────────────────────
  fastify.post('/api/moderation/posts/:postId/remove', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: idParam } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: ['string', 'null'], maxLength: 64 },
          // Ids and enums only in moderation_actions — never a copy of the
          // body. That table is exempt from the 24h rule, so putting content
          // in it would smuggle user text past the retention ceiling into
          // something nothing ever reaps.
          reason: { type: ['string', 'null'], maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;

    const removed = await fastify.repos.posts.removePost(
      request.params.postId, request.user.id, request.body ?? {}
    );
    if (!removed) return reply.code(404).send({ error: 'Post not found' });

    return reply.code(204).send();
  });

  // ─── POSTING BLOCK ────────────────────────────────────────
  // The only sanction that outlives the content. A post is gone within a day
  // regardless, so acting on the author is the only durable remedy.
  fastify.post('/api/moderation/users/:userId/posting-block', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: idParam } },
      body: {
        type: 'object',
        required: ['days'],
        additionalProperties: false,
        properties: {
          // 0 lifts it, which is why this is one route and not two.
          days: { type: 'integer', minimum: 0, maximum: 3650 },
          reason: { type: ['string', 'null'], maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;

    const ok = await fastify.repos.posts.setPostingBlock(
      request.params.userId, request.user.id, request.body
    );
    if (!ok) return reply.code(404).send({ error: 'User not found' });

    return reply.code(204).send();
  });
}

export default moderationRoutes;
