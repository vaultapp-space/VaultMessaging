// ============================================================
// Vault — Thoughts (public posts)
// ============================================================
// The public square. Unlike every other content route in this app, a post is
// not addressed to a chat and is not gated by membership — it is visible to
// everyone unless a block or mute says otherwise.
//
// Three things follow from that and are enforced here rather than left to the
// caller:
//
// **Rate limits are IP-keyed, like every other route here — but they should
// not be.** What deserves limiting on this surface is an *account's* behaviour:
// IP keying both under-limits (one spammer, many IPs) and over-limits (a
// university NAT shares one bucket for a whole campus, which on a public feed
// is a visible failure). Keying on `request.user.id` does not work today:
// @fastify/rate-limit runs its keyGenerator on the `onRequest` hook, which is
// before the `preValidation` that authenticates, so `request.user` is always
// undefined there and the key silently falls back to the IP — worse than
// leaving it alone, because it looks correct.
//
// Fixing it properly means registering the plugin with `hook: 'preHandler'`
// (see app.js), which changes limiting for every route in the app. That has
// its own blast radius and does not belong in the same change as a new
// feature. Until then these numbers assume an IP bucket.
//
// **Posts expire in 24h like everything else**, which is what keeps a
// chronological global timeline cheap — the table never holds more than a day.
// The UI has to say so out loud, or a quiet feed reads as a broken one.
//
// **The media schema is closed.** `POST /api/stories` accepts
// `additionalProperties: true` on its media object — attacker-controlled JSON
// that later reaches an <img src>. That is not copied here.

import { UUID_PATTERN } from '../utils/constants.js';
import { ALLOWED_MEDIA_MIME } from './media.routes.js';

const MAX_BODY_LENGTH = 500;
const postParam = { type: 'string', pattern: UUID_PATTERN };

const mediaSchema = {
  type: 'object',
  required: ['fileId', 'mimeType'],
  additionalProperties: false,
  properties: {
    fileId: { type: 'string', pattern: UUID_PATTERN },
    mimeType: { type: 'string', enum: [...ALLOWED_MEDIA_MIME.keys()] },
    width: { type: 'integer', minimum: 1, maximum: 10000 },
    height: { type: 'integer', minimum: 1, maximum: 10000 },
  },
};

// The cursor is opaque to the client: base64 of `<createdAt>|<id>`. Handing the
// client two raw values that go straight into a row comparison invites it to
// send something the planner chokes on, or a crafted pair that walks rows it
// should not reach.
function encodeCursor(post) {
  return Buffer.from(`${new Date(post.createdAt).toISOString()}|${post.id}`).toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) return null;
  if (!new RegExp(UUID_PATTERN).test(id)) return null;
  return { createdAt, id };
}

async function postRoutes(fastify) {

  // ─── CREATE ───────────────────────────────────────────────
  fastify.post('/api/posts', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          body: { type: ['string', 'null'], maxLength: MAX_BODY_LENGTH },
          media: { ...mediaSchema, nullable: true },
          // A reply and a repost are the same row shape with a different
          // reference set; both are optional and mutually exclusive.
          replyToId: { type: ['string', 'null'], pattern: UUID_PATTERN },
          repostOfId: { type: ['string', 'null'], pattern: UUID_PATTERN },
        },
      },
    },
  }, async (request, reply) => {
    const { body = null, media = null, replyToId = null, repostOfId = null } = request.body ?? {};

    if (replyToId && repostOfId) {
      return reply.code(400).send({ error: 'A post cannot be both a reply and a repost' });
    }
    // Mirrors the posts_have_content CHECK, so the caller gets a sentence
    // rather than a constraint violation.
    if (!body?.trim() && !media && !repostOfId) {
      return reply.code(400).send({ error: 'A post needs text, media, or something to repost' });
    }

    const post = await fastify.repos.posts.create(
      { id: request.user.id, username: request.user.username },
      { body: body?.trim() || null, media, replyToId, repostOfId }
    );

    // Null means the parent is gone, expired or removed. 404 rather than 400:
    // whether a post exists is not something to confirm to a stranger.
    if (!post) return reply.code(404).send({ error: 'That post is no longer available' });

    return reply.code(201).send({ post });
  });

  // ─── TIMELINE ─────────────────────────────────────────────
  fastify.get('/api/posts/timeline', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      querystring: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: ['global', 'following'], default: 'global' },
          cursor: { type: 'string', maxLength: 128 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { tab, cursor: rawCursor, limit } = request.query;

    // A cursor that does not decode is a client bug or a probe; starting from
    // the top is the harmless reading of it.
    const cursor = decodeCursor(rawCursor);

    const { posts, hasMore } = await fastify.repos.posts.timeline(request.user.id, {
      tab, cursor, limit,
    });

    return reply.send({
      posts,
      hasMore,
      nextCursor: hasMore && posts.length ? encodeCursor(posts[posts.length - 1]) : null,
      // Stated in the payload so the client never has to hardcode it, the way
      // channels return retentionSeconds.
      retentionSeconds: fastify.repos.posts.ttlSeconds,
    });
  });

  // ─── READ ONE ─────────────────────────────────────────────
  fastify.get('/api/posts/:postId', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
    },
  }, async (request, reply) => {
    const post = await fastify.repos.posts.get(request.user.id, request.params.postId);
    // Also the answer when the author blocked the viewer — deliberately
    // indistinguishable from "deleted", as elsewhere in this codebase.
    if (!post) return reply.code(404).send({ error: 'Post not found' });
    return reply.send({ post });
  });

  // ─── DELETE OWN ───────────────────────────────────────────
  fastify.delete('/api/posts/:postId', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
    },
  }, async (request, reply) => {
    // The repo unlinks the image with the row — a file left behind is served
    // to anyone holding the URL, which for content the author just deleted is
    // the whole problem.
    const deleted = await fastify.repos.posts.deleteOwn(request.user.id, request.params.postId);
    // 404 for someone else's post as well as a missing one.
    if (!deleted) return reply.code(404).send({ error: 'Post not found' });

    return reply.code(204).send();
  });
}

export default postRoutes;
