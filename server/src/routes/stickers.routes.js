// ============================================================
// Vault — Stickers
// ============================================================
// Sets, installation, favourites, recents, and emoji suggestion.
//
// Sticker *files* do not live here either — they go through the shared public
// media path in media.routes.js, which stories also use. Both are public
// assets shown to an audience rather than encrypted to a recipient, and
// having one uploader means one mime allowlist to keep correct.
//
// Sending a sticker does *not* happen here. A sticker message is an ordinary
// message with `t:'sticker'` carrying a reference to the sticker, so it goes
// through the same dual-mode send path as everything else — which is what
// lets stickers work in secret chats without the server learning that one was
// sent, let alone which.
//
// The one place this file touches a conversation is `/use`, which records a
// recent. That is deliberately a separate call the client makes for itself,
// rather than something inferred from a send: inferring it would require the
// server to see sticker sends in secret chats, which it must not.

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const idParam = { type: 'string', pattern: UUID_PATTERN };

async function stickerRoutes(fastify) {

  // ─── MY PICKER ────────────────────────────────────────────
  // Everything the picker needs in one call: a picker that opened and then
  // fired three requests would show its sections popping in one by one.
  fastify.get('/api/stickers', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const userId = request.user.id;
    const [sets, favorites, recents] = await Promise.all([
      fastify.repos.stickers.installedSets(userId),
      fastify.repos.stickers.favorites(userId),
      fastify.repos.stickers.recents(userId),
    ]);
    return { sets, favorites, recents };
  });

  // ─── CREATE a set ─────────────────────────────────────────
  fastify.post('/api/stickers/sets', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['shortName', 'title'],
        properties: {
          shortName: { type: 'string', minLength: 3, maxLength: 64 },
          title:     { type: 'string', minLength: 1, maxLength: 128 },
          // 'emoji' sets render inline in message text through the entity
          // system; 'regular' ones appear in the picker.
          type:      { type: 'string', enum: ['regular', 'emoji', 'mask'], default: 'regular' },
        },
      },
    },
  }, async (request, reply) => {
    const result = await fastify.repos.stickers.createSet(request.user.id, request.body);
    if (!result.ok) return reply.code(409).send({ error: result.reason });

    // The creator gets it installed — otherwise making a set leaves you
    // unable to use it without searching for your own work.
    await fastify.repos.stickers.install(request.user.id, result.set.id);
    return reply.code(201).send(result.set);
  });

  // ─── ADD a sticker to a set ───────────────────────────────
  fastify.post('/api/stickers/sets/:setId/stickers', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['setId'], properties: { setId: idParam } },
      body: {
        type: 'object',
        required: ['fileId'],
        properties: {
          fileId:     idParam,
          emoji:      { type: ['string', 'null'], maxLength: 16 },
          width:      { type: ['integer', 'null'], minimum: 1, maximum: 2048 },
          height:     { type: ['integer', 'null'], minimum: 1, maximum: 2048 },
          // Carried so animated formats can be added later as a renderer
          // change rather than a migration. Nothing renders them today.
          isAnimated: { type: 'boolean', default: false },
          isVideo:    { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const set = await fastify.repos.stickers.getSet(request.params.setId);
    if (!set) return reply.code(404).send({ error: 'Set not found' });
    if (set.ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'You do not own that set' });
    }

    const sticker = await fastify.repos.stickers.addSticker(set.id, request.body);
    // A sticker file is permanent by design — a set is a library the user
    // installed — so claiming it is what keeps the orphan sweep away from it
    // for good. See media.repo.js.
    await fastify.repos.media.claim(request.body.fileId);
    return reply.code(201).send(sticker);
  });

  // ─── GET a set ────────────────────────────────────────────
  fastify.get('/api/stickers/sets/:shortName', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['shortName'],
        properties: { shortName: { type: 'string', maxLength: 64 } },
      },
    },
  }, async (request, reply) => {
    const set = await fastify.repos.stickers.getSetByShortName(request.params.shortName);
    if (!set) return reply.code(404).send({ error: 'Set not found' });

    return reply.send({
      ...set,
      stickers: await fastify.repos.stickers.stickersInSet(set.id),
      installed: await fastify.repos.stickers.isInstalled(request.user.id, set.id),
    });
  });

  // ─── SEARCH sets ──────────────────────────────────────────
  fastify.get('/api/stickers/search', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object', required: ['q'],
        properties: { q: { type: 'string', minLength: 1, maxLength: 64 } },
      },
    },
  }, async (request) => ({
    sets: await fastify.repos.stickers.searchSets(request.query.q),
  }));

  // ─── INSTALL / UNINSTALL ──────────────────────────────────
  fastify.post('/api/stickers/sets/:setId/install', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['setId'], properties: { setId: idParam } },
    },
  }, async (request, reply) => {
    const set = await fastify.repos.stickers.getSet(request.params.setId);
    if (!set) return reply.code(404).send({ error: 'Set not found' });

    await fastify.repos.stickers.install(request.user.id, set.id);
    return reply.send({ installed: true });
  });

  fastify.delete('/api/stickers/sets/:setId/install', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['setId'], properties: { setId: idParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.stickers.uninstall(request.user.id, request.params.setId);
    return reply.send({ installed: false });
  });

  // ─── FAVOURITES ───────────────────────────────────────────
  fastify.post('/api/stickers/:stickerId/favorite', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['stickerId'], properties: { stickerId: idParam } },
    },
  }, async (request, reply) => {
    const sticker = await fastify.repos.stickers.getSticker(request.params.stickerId);
    if (!sticker) return reply.code(404).send({ error: 'Sticker not found' });

    await fastify.repos.stickers.favorite(request.user.id, sticker.id);
    return reply.send({ favorited: true });
  });

  fastify.delete('/api/stickers/:stickerId/favorite', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['stickerId'], properties: { stickerId: idParam } },
    },
  }, async (request, reply) => {
    await fastify.repos.stickers.unfavorite(request.user.id, request.params.stickerId);
    return reply.send({ favorited: false });
  });

  // ─── RECENTS ──────────────────────────────────────────────
  //
  // Called by the client after it sends a sticker, rather than inferred from
  // the send. Inferring it would mean the server watching sticker sends,
  // which in a secret chat it cannot and must not do.
  //
  // The list is capped, and that cap is a privacy control: unbounded, it
  // becomes a durable record of what someone has been sending.
  fastify.post('/api/stickers/:stickerId/use', {
    preValidation: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['stickerId'], properties: { stickerId: idParam } },
    },
  }, async (request, reply) => {
    const sticker = await fastify.repos.stickers.getSticker(request.params.stickerId);
    if (!sticker) return reply.code(404).send({ error: 'Sticker not found' });

    await fastify.repos.stickers.touchRecent(request.user.id, sticker.id);
    return reply.send({ ok: true });
  });

  fastify.delete('/api/stickers/recents', {
    preValidation: [fastify.authenticate],
  }, async (request, reply) => {
    await fastify.repos.stickers.clearRecents(request.user.id);
    return reply.send({ cleared: true });
  });

  // ─── EMOJI SUGGESTION ─────────────────────────────────────
  // Typing an emoji offers matching stickers. Scoped to installed sets: the
  // alternative offers stickers the user cannot send, and tells someone who
  // installed nothing which sets exist.
  fastify.get('/api/stickers/suggest', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object', required: ['emoji'],
        properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } },
      },
    },
  }, async (request) => ({
    stickers: await fastify.repos.stickers.suggestForEmoji(
      request.user.id, request.query.emoji
    ),
  }));
}

export default stickerRoutes;
