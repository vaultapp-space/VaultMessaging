// ============================================================
// Vault — Public media
// ============================================================
// Upload and serve for assets that are **public and non-expiring by nature**:
// sticker images and story photos.
//
// This is deliberately *not* the attachment path. An attachment is encrypted
// per-recipient and expires in 24 hours; these are shown to an audience the
// author chose and are not encrypted to anyone in particular. Running them
// through the attachment path would either make every sticker vanish daily or
// make the E2EE path lie about what it protects.
//
// One uploader for both, because the thing that must stay correct — the mime
// allowlist — is easier to keep right in one place than two.
//
// Retention nuance worth knowing: a **sticker** file persists (a set is a
// library the user installed), but a **story** file must not. The reaper
// deletes a story's file when the story expires; without that the image would
// outlive the row and stay reachable by anyone who kept the URL.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// An allowlist, not a denylist: a new format is a considered decision rather
// than whatever a client happens to send. **SVG is excluded on purpose** — it
// is a script execution vector, and these files are served into other
// people's browsers.
export const ALLOWED_MEDIA_MIME = new Map([
  ['image/webp', '.webp'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['video/webm', '.webm'],
]);

const MAX_MEDIA_BYTES = 512 * 1024;

async function mediaRoutes(fastify) {
  const mediaDir = path.join(fastify.store.uploadsDir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });

  fastify.post('/api/media/upload', {
    preValidation: [fastify.authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['mimeType', 'data'],
        properties: {
          mimeType: { type: 'string', maxLength: 64 },
          // base64; the decoded size is what is actually enforced below.
          data: { type: 'string', maxLength: Math.ceil(MAX_MEDIA_BYTES * 1.4) },
        },
      },
    },
  }, async (request, reply) => {
    const { mimeType, data } = request.body;
    const extension = ALLOWED_MEDIA_MIME.get(mimeType);
    if (!extension) {
      return reply.code(415).send({ error: 'Unsupported media format' });
    }

    let bytes;
    try {
      bytes = Buffer.from(data, 'base64');
    } catch {
      return reply.code(400).send({ error: 'Malformed media data' });
    }
    if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
      return reply.code(413).send({ error: 'File too large' });
    }

    const fileId = crypto.randomUUID();
    // The id is generated here and the extension comes from the allowlist, so
    // neither half of the filename is attacker-controlled — there is nothing
    // to traverse with.
    await fs.promises.writeFile(path.join(mediaDir, `${fileId}${extension}`), bytes);

    return reply.code(201).send({ fileId, mimeType });
  });

  fastify.get('/api/media/:fileId', {
    schema: {
      params: {
        type: 'object', required: ['fileId'],
        properties: { fileId: { type: 'string', pattern: UUID_PATTERN } },
      },
    },
  }, async (request, reply) => {
    const { fileId } = request.params;

    for (const [mimeType, extension] of ALLOWED_MEDIA_MIME) {
      try {
        const bytes = await fs.promises.readFile(
          path.join(mediaDir, `${fileId}${extension}`)
        );
        return reply
          .header('Content-Type', mimeType)
          // Immutable: an id never changes what it points at, because ids are
          // generated per upload and never reused.
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          // These are user-uploaded files served to other people's browsers.
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('X-Content-Type-Options', 'nosniff')
          .send(bytes);
      } catch {
        // Try the next extension.
      }
    }

    return reply.code(404).send({ error: 'Not found' });
  });
}

export default mediaRoutes;
