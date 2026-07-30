// ============================================================
// Vault — E2EE Ephemeral Attachment Chunks Router
// ============================================================

import { MAX_MEDIA_CHUNK_SIZE } from '../utils/constants.js';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
// Base64 inflates size by ~4/3; add headroom for the AES-GCM auth tag.
const MAX_CHUNK_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_MEDIA_CHUNK_SIZE * 4 / 3) + 1024;

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
    
    // Save placeholder attachment in disk-backed store
    const id = await fastify.store.saveAttachment(filename, mimeType, totalChunks, burnOnRead, request.user.id);
    
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
          id:    { type: 'string', pattern: UUID_PATTERN },
          index: { type: 'integer', minimum: 0 }
        }
      },
      body: {
        type: 'object',
        required: ['ciphertext'],
        properties: {
          ciphertext: { type: 'string', maxLength: MAX_CHUNK_CIPHERTEXT_BASE64_LENGTH }
        }
      }
    }
  }, async (request, reply) => {
    const { id, index } = request.params;
    const { ciphertext } = request.body;

    const chunkSize = Math.round(ciphertext.length * 0.75);
    try {
      await fastify.store.checkAndIncrementUploadUsage(request.user.id, chunkSize);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    const attachment = await fastify.store.getAttachment(id);
    if (!attachment) {
      return reply.code(404).send({ error: 'Upload session not found' });
    }

    if (attachment.owner_id !== request.user.id) {
      return reply.code(403).send({ error: 'Only owner can upload chunks' });
    }

    if (index >= attachment.totalChunks) {
      return reply.code(400).send({ error: 'Index out of bounds' });
    }

    // Save chunk to disk
    await fastify.store.saveChunk(id, index, ciphertext);
    
    // Fetch updated count
    const updatedAttachment = await fastify.store.getAttachment(id);
    return reply.send({ success: true, uploadedChunks: updatedAttachment.uploadedChunks });
  });

  // ─── DOWNLOAD chunk index ───────────────────────────────
  fastify.get('/api/attachments/chunk/download/:id/:index', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'index'],
        properties: {
          id:    { type: 'string', pattern: UUID_PATTERN },
          index: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id, index } = request.params;

    const attachment = await fastify.store.getAttachment(id);
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

    const chunkCiphertext = await fastify.store.getChunk(id, index);
    if (!chunkCiphertext) {
      return reply.code(404).send({ error: 'Chunk not uploaded yet' });
    }

    // Burn-on-Read chunk cleanup
    if (attachment.burn_on_read && request.user.id !== attachment.owner_id) {
      // If it is the last chunk, clear the user and see if we should delete
      if (index === attachment.totalChunks - 1) {
        // Schedule cleanup after sending response
        setImmediate(async () => {
          await fastify.store.revokeAttachmentUser(id, request.user.id);
          const remainingRecipients = await fastify.store.countRemainingRecipients(id, attachment.owner_id);
          if (remainingRecipients === 0) {
            await fastify.store.deleteAttachment(id);
            fastify.log.info({ attachmentId: id }, 'Burn-on-read: all recipients have read. Purged entire chunked attachment from disk and DB');
          }
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
