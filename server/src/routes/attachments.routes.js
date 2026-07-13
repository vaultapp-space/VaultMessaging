// ============================================================
// Vault — E2EE Ephemeral Attachments Router
// ============================================================

async function attachmentRoutes(fastify) {

  // ─── UPLOAD attachment ──────────────────────────────
  fastify.post('/api/attachments', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['filename', 'mimeType', 'ciphertext'],
        properties: {
          filename:   { type: 'string', maxLength: 255 },
          mimeType:   { type: 'string', maxLength: 100 },
          ciphertext: { type: 'string', maxLength: 10 * 1024 * 1024 }, // limit base64 payload to ~10MB
          burnOnRead: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { filename, mimeType, ciphertext, burnOnRead } = request.body;
    
    const fileSize = Math.round(ciphertext.length * 0.75);
    try {
      await fastify.store.checkAndIncrementUploadUsage(request.user.id, fileSize);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    // Save attachment in disk-backed store
    const id = await fastify.store.saveAttachment(filename, mimeType, ciphertext, burnOnRead, request.user.id);
    
    return reply.code(201).send({ id });
  });

  // ─── DOWNLOAD attachment ────────────────────────────
  fastify.get('/api/attachments/:id', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    
    const attachment = await fastify.store.getAttachment(id);
    if (!attachment) {
      return reply.code(404).send({ error: 'Attachment not found or expired' });
    }

    // Access control validation
    if (attachment.allowed_users && !attachment.allowed_users.has(request.user.id)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // Read ciphertext from disk (chunk 0)
    const ciphertext = await fastify.store.getChunk(id, 0);
    if (!ciphertext) {
      return reply.code(404).send({ error: 'Attachment file not found' });
    }

    const payload = {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      ciphertext: ciphertext
    };

    if (attachment.burn_on_read) {
      await fastify.store.deleteAttachment(id);
      fastify.log.info({ attachmentId: id }, 'Burn-on-read: purged attachment from disk and DB');
    }
    
    return reply.send(payload);
  });

}

export default attachmentRoutes;
