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

    // An operator restriction. Checked on the write path only — a blocked
    // account can still read, follow and like, because the sanction is on
    // publishing, not on existing.
    if (await fastify.repos.posts.isPostingBlocked(request.user.id)) {
      return reply.code(403).send({ error: 'Your account is currently blocked from posting' });
    }

    const post = await fastify.repos.posts.create(
      { id: request.user.id, username: request.user.username },
      { body: body?.trim() || null, media, replyToId, repostOfId }
    );

    // Null means the parent is gone, expired or removed. 404 rather than 400:
    // whether a post exists is not something to confirm to a stranger.
    if (!post) return reply.code(404).send({ error: 'That post is no longer available' });

    // The file now belongs to content, so the orphan sweep must leave it alone.
    // After the insert, not before: claiming a file for a post that then failed
    // to create would strand it permanently, which is the exact leak the ledger
    // exists to close.
    if (media?.fileId) await fastify.repos.media.claim(media.fileId);

    // Nudge whoever is watching the feed. Only top-level posts: a reply is not
    // a timeline event, and ticking for one would refresh every open feed for
    // something that will not appear in it.
    //
    // Not awaited, and it cannot throw — notePost only sets a flag and arms a
    // timer. The fanout happens on that timer, off this request.
    if (!replyToId) fastify.feedTicker.notePost();

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

  // ─── REPLIES ──────────────────────────────────────────────
  fastify.get('/api/posts/:postId/replies', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', maxLength: 128 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    // Reading the root first means a blocked or removed root hides its whole
    // thread, rather than the replies remaining reachable on their own.
    const root = await fastify.repos.posts.get(request.user.id, request.params.postId);
    if (!root) return reply.code(404).send({ error: 'Post not found' });

    const { posts, hasMore } = await fastify.repos.posts.replies(
      request.user.id,
      request.params.postId,
      { cursor: decodeCursor(request.query.cursor), limit: request.query.limit }
    );

    return reply.send({
      posts,
      hasMore,
      nextCursor: hasMore && posts.length ? encodeCursor(posts[posts.length - 1]) : null,
    });
  });

  // ─── LIKES ────────────────────────────────────────────────
  // Highest-frequency legitimate action on the surface — thumb-scrolling and
  // tapping — so the limit is per minute rather than per hour.
  fastify.post('/api/posts/:postId/like', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
    },
  }, async (request, reply) => {
    // Visibility first: liking a post you cannot see would leak its existence
    // through the counter.
    const visible = await fastify.repos.posts.get(request.user.id, request.params.postId);
    if (!visible) return reply.code(404).send({ error: 'Post not found' });

    const likesCount = await fastify.repos.posts.like(request.params.postId, request.user.id);
    if (likesCount === null) return reply.code(404).send({ error: 'Post not found' });
    return reply.send({ likesCount, likedByMe: true });
  });

  fastify.delete('/api/posts/:postId/like', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
    },
  }, async (request, reply) => {
    const likesCount = await fastify.repos.posts.unlike(request.params.postId, request.user.id);
    if (likesCount === null) return reply.code(404).send({ error: 'Post not found' });
    return reply.send({ likesCount, likedByMe: false });
  });

  // ─── PROFILES ─────────────────────────────────────────────
  fastify.get('/api/users/:username/profile', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', minLength: 3, maxLength: 32 } },
      },
    },
  }, async (request, reply) => {
    const profile = await fastify.repos.posts.profile(request.user.id, request.params.username);
    // Also the answer for a user who blocked the viewer: a profile that renders
    // for someone you blocked is a hole in the block.
    if (!profile) return reply.code(404).send({ error: 'User not found' });
    return reply.send({ profile });
  });

  fastify.get('/api/users/:username/posts', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', minLength: 3, maxLength: 32 } },
      },
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', maxLength: 128 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { posts, hasMore } = await fastify.repos.posts.byAuthor(
      request.user.id,
      request.params.username,
      { cursor: decodeCursor(request.query.cursor), limit: request.query.limit }
    );

    return reply.send({
      posts,
      hasMore,
      nextCursor: hasMore && posts.length ? encodeCursor(posts[posts.length - 1]) : null,
    });
  });

  // ─── FOLLOWS ──────────────────────────────────────────────
  // Mass-follow is the classic growth-hack abuse, so this is capped hard.
  fastify.post('/api/users/:userId/follow', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: postParam } },
    },
  }, async (request, reply) => {
    if (request.params.userId === request.user.id) {
      return reply.code(409).send({ error: 'You cannot follow yourself' });
    }
    const ok = await fastify.repos.posts.follow(request.user.id, request.params.userId);
    if (!ok) return reply.code(404).send({ error: 'User not found' });
    return reply.code(204).send();
  });

  fastify.delete('/api/users/:userId/follow', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: postParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.posts.unfollow(request.user.id, request.params.userId);
    return reply.code(204).send();
  });

  fastify.get('/api/users/:userId/:direction(followers|following)', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object',
        required: ['userId', 'direction'],
        properties: {
          userId: postParam,
          direction: { type: 'string', enum: ['followers', 'following'] },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const users = await fastify.repos.posts.listFollows(
      request.params.userId,
      request.params.direction,
      { limit: request.query.limit, offset: request.query.offset }
    );
    return reply.send({ users });
  });

  // ─── MUTES ────────────────────────────────────────────────
  // Mute is not block: one-way, silent, and feed-only. Server-side rather than
  // client-side because a client-side mute still ships the content over the
  // wire, which makes "I don't want to see this" cosmetic.
  fastify.post('/api/users/:userId/mute', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: postParam } },
    },
  }, async (request, reply) => {
    if (request.params.userId === request.user.id) {
      return reply.code(409).send({ error: 'You cannot mute yourself' });
    }
    const ok = await fastify.repos.posts.mute(request.user.id, request.params.userId);
    if (!ok) return reply.code(404).send({ error: 'User not found' });
    return reply.code(204).send();
  });

  fastify.delete('/api/users/:userId/mute', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: postParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.posts.unmute(request.user.id, request.params.userId);
    return reply.code(204).send();
  });

  fastify.get('/api/mutes', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    return reply.send({ users: await fastify.repos.posts.listMutes(request.user.id) });
  });

  // ─── REPORTING ────────────────────────────────────────────
  // The category list *is* the content policy. Nothing is removed here for
  // being disagreeable — only for being illegal — so offering "offensive" or
  // "misinformation" would promise a review that will not happen and fill the
  // queue with complaints nobody intends to action. The enum is the honest
  // version of the promise, and it is enforced by a CHECK constraint too.
  fastify.post('/api/posts/:postId/report', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      params: { type: 'object', required: ['postId'], properties: { postId: postParam } },
      body: {
        type: 'object',
        required: ['category'],
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['csam', 'terrorism', 'nonconsensual_intimate',
                   'credible_threat', 'other_illegal'],
          },
          note: { type: ['string', 'null'], maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const visible = await fastify.repos.posts.get(request.user.id, request.params.postId);
    if (!visible) return reply.code(404).send({ error: 'Post not found' });

    await fastify.repos.posts.report(request.params.postId, request.user.id, request.body);
    // 204 whether or not this was a duplicate: telling a reporter "you already
    // reported this" is noise, and confirming it would let someone probe
    // whether an account of theirs had reported something.
    return reply.code(204).send();
  });
}

export default postRoutes;
