// ============================================================
// Vault — E2EE Ephemeral Attachment Chunks Router
// ============================================================

async function chunkRoutes(fastify) {

  // ─── INIT chunked upload session ────────────────────────
  fastify.post('/api/attachments/chunk/init', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['filename', 'mimeType', 'totalChunks'],
        properties: {
          filename:    { type: 'string', maxLength: 255 },
          mimeType:    { type: 'string', maxLength: 100 },
          totalChunks: { type: 'integer', minimum: 1, maximum: 10 },
          burnOnRead:  { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { filename, mimeType, totalChunks, burnOnRead } = request.body;
    
    // Save placeholder attachment in memory store
    const id = fastify.store.saveAttachment(filename, mimeType, '', burnOnRead, request.user.id);
    
    // Supplement store data with chunk details
    const attachment = fastify.store.getAttachment(id);
    if (attachment) {
      attachment.totalChunks = totalChunks;
      attachment.uploadedChunks = 0;
      attachment.chunks = new Array(totalChunks).fill(null);
    }

    return reply.code(201).send({ id });
  });

  // ─── UPLOAD chunk index ─────────────────────────────────
  fastify.post('/api/attachments/chunk/upload/:id/:index', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'index'],
        properties: {
          id:    { type: 'string' },
          index: { type: 'integer', minimum: 0 }
        }
      },
      body: {
        type: 'object',
        required: ['ciphertext'],
        properties: {
          ciphertext: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id, index } = request.params;
    const { ciphertext } = request.body;

    const attachment = fastify.store.getAttachment(id);
    if (!attachment) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }

    if (attachment.owner_id !== request.user.id) {
      return reply.code(403).send({ error: 'Only owner can upload chunks' });
    }

    if (index >= attachment.totalChunks) {
      return reply.code(400).send({ error: 'Index out of bounds' });
    }

    // Save chunk
    attachment.chunks[index] = ciphertext;
    attachment.uploadedChunks++;

    return reply.send({ success: true, uploadedChunks: attachment.uploadedChunks });
  });

  // ─── DOWNLOAD chunk index ───────────────────────────────
  fastify.get('/api/attachments/chunk/download/:id/:index', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'index'],
        properties: {
          id:    { type: 'string' },
          index: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id, index } = request.params;

    const attachment = fastify.store.getAttachment(id);
    if (!attachment) {
      return reply.code(404).send({ error: 'Attachment not found or expired' });
    }

    // Access control validation
    if (attachment.allowed_users && !attachment.allowed_users.has(request.user.id)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (index >= attachment.totalChunks) {
      return reply.code(400).send({ error: 'Index out of bounds' });
    }

    const chunkCiphertext = attachment.chunks[index];
    if (!chunkCiphertext) {
      return reply.code(404).send({ error: 'Chunk not uploaded yet' });
    }

    // Burn-on-Read chunk cleanup
    if (attachment.burn_on_read) {
      // If it is the last chunk, clear the whole attachment after dispatching
      if (index === attachment.totalChunks - 1) {
        // Schedule cleanup after sending response
        setImmediate(() => {
          fastify.store.media.delete(id);
          fastify.log.info({ attachmentId: id }, 'Burn-on-read: purged entire chunked attachment from memory');
        });
      }
    }

    return reply.send({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      ciphertext: chunkCiphertext,
      index,
      totalChunks: attachment.totalChunks
    });
  });

}

export default chunkRoutes;
