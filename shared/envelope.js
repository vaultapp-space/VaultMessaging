// ============================================================
// Vault — Message Envelope (v1)
// ============================================================
// The typed shape every message payload takes, shared by client and server.
//
// Why this exists
// ---------------
// A message used to be an opaque string, and its type was recovered by
// sniffing that string's prefix:
//
//     message.text.startsWith('{"type":"attachment"')
//
// That worked for exactly one alternative to plain text. Reactions, replies,
// edits, deletes, pins, polls and stickers each need to travel as their own
// kind of payload, and none of them can be distinguished by a prefix check.
//
// How it is carried
// -----------------
// In a secret (end-to-end encrypted) chat, the envelope is JSON.stringify'd
// and that string becomes the ratchet plaintext — the server still sees only
// ciphertext, exactly as before. In a cloud chat the same fields are stored
// as columns. Both sides of that fork produce the identical in-memory shape,
// which is what lets one composer and one message list serve both.
//
// Operations (t: 'op')
// --------------------
// This is the piece that makes feature parity affordable. Reacting to a
// message in a cloud chat is an HTTP call that mutates a table. In a secret
// chat the *same* envelope is encrypted through the existing ratchet, sent as
// an ordinary message, and applied client-side on receipt. The UI never has
// to know which happened.

export const ENVELOPE_VERSION = 1;

/** Payload kinds an envelope can carry. */
export const MessageType = Object.freeze({
  TEXT: 'text',
  PHOTO: 'photo',
  VIDEO: 'video',
  VOICE: 'voice',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker',
  POLL: 'poll',
  LOCATION: 'location',
  CONTACT: 'contact',
  SERVICE: 'service',
  OP: 'op',
});

const MESSAGE_TYPES = new Set(Object.values(MessageType));

/** Mutations that ride inside a `t: 'op'` envelope. */
export const OpKind = Object.freeze({
  REACT: 'react',
  UNREACT: 'unreact',
  EDIT: 'edit',
  DELETE: 'delete',
  PIN: 'pin',
  UNPIN: 'unpin',
  READ: 'read',
  DRAFT: 'draft',
});

const OP_KINDS = new Set(Object.values(OpKind));

/**
 * Text formatting spans, in Telegram's entity format.
 *
 * Adopted now rather than later on purpose: entities are what let markdown,
 * mentions, link previews, custom emoji and bot output share one
 * representation. Retrofitting them onto already-stored plaintext would be a
 * data migration, so the cost of adding them up front is close to zero and
 * the cost of deferring them is not.
 */
export const EntityType = Object.freeze({
  BOLD: 'bold',
  ITALIC: 'italic',
  UNDERLINE: 'underline',
  STRIKETHROUGH: 'strikethrough',
  SPOILER: 'spoiler',
  CODE: 'code',
  PRE: 'pre',
  BLOCKQUOTE: 'blockquote',
  URL: 'url',
  TEXT_LINK: 'text_link',
  MENTION: 'mention',
  HASHTAG: 'hashtag',
  CUSTOM_EMOJI: 'custom_emoji',
});

/**
 * Builds a well-formed envelope, filling in the fields consumers can rely on
 * always being present.
 */
export function createEnvelope({
  t = MessageType.TEXT,
  body = null,
  entities = [],
  media = null,
  replyTo = null,
  fwd = null,
  groupedId = null,
  ttl = null,
  op = null,
  // Cloud only. The server clears the message once every other member has
  // opened it, which is what makes this a guarantee rather than a request —
  // a client-side-only version is defeated by the network tab. Secret chats
  // have burn-on-read instead, which is honestly labelled as client-side.
  viewOnce = false,
} = {}) {
  if (!MESSAGE_TYPES.has(t)) {
    throw new Error(`Unknown message type: ${t}`);
  }
  if (t === MessageType.OP && !op) {
    throw new Error("An envelope of type 'op' must carry an op");
  }
  if (op && !OP_KINDS.has(op.kind)) {
    throw new Error(`Unknown op kind: ${op.kind}`);
  }

  return {
    v: ENVELOPE_VERSION,
    t,
    body,
    entities,
    media,
    replyTo,
    fwd,
    groupedId,
    ttl,
    op,
    viewOnce,
  };
}

export function createTextEnvelope(body, options = {}) {
  return createEnvelope({ ...options, t: MessageType.TEXT, body });
}

/**
 * Media envelope. `kind` picks the concrete type so a voice note, a photo and
 * a generic file are distinguishable without inspecting the mime type.
 */
export function createMediaEnvelope(kind, media, options = {}) {
  return createEnvelope({ ...options, t: kind, media });
}

export function createOpEnvelope(op, options = {}) {
  return createEnvelope({ ...options, t: MessageType.OP, op });
}

export function isOp(envelope, kind = null) {
  if (!envelope || envelope.t !== MessageType.OP || !envelope.op) return false;
  return kind === null || envelope.op.kind === kind;
}

export function isMedia(envelope) {
  if (!envelope) return false;
  return [
    MessageType.PHOTO, MessageType.VIDEO, MessageType.VOICE,
    MessageType.AUDIO, MessageType.DOCUMENT, MessageType.STICKER,
  ].includes(envelope.t);
}

/** Serialises an envelope for transport. In secret chats this is the ratchet plaintext. */
export function serializeEnvelope(envelope) {
  return JSON.stringify(envelope);
}

// ─── Legacy interop ─────────────────────────────────────────
//
// Messages sent before this module existed carry a bare string: either plain
// text, or a JSON blob starting with {"type":"attachment". Both must keep
// rendering. The 24h expiry ceiling means such messages disappear on their
// own within a day of release — a genuinely convenient property, and the
// reason this shim can be deleted rather than maintained. It stops being
// available the moment messages are allowed to persist.

const LEGACY_ATTACHMENT_PREFIX = '{"type":"attachment"';

function mediaTypeForMime(mimeType = '') {
  if (mimeType.startsWith('image/')) return MessageType.PHOTO;
  if (mimeType.startsWith('video/')) return MessageType.VIDEO;
  if (mimeType.startsWith('audio/')) return MessageType.VOICE;
  return MessageType.DOCUMENT;
}

/** True if the payload predates the envelope format. */
export function isLegacyPayload(raw) {
  if (typeof raw !== 'string') return false;
  if (raw.startsWith(LEGACY_ATTACHMENT_PREFIX)) return true;
  try {
    const parsed = JSON.parse(raw);
    return !(parsed && typeof parsed === 'object' && parsed.v === ENVELOPE_VERSION);
  } catch {
    return true; // bare text
  }
}

/** Lifts a pre-envelope payload into the current shape. */
export function fromLegacyPayload(raw) {
  if (typeof raw !== 'string') return createTextEnvelope('');

  if (raw.startsWith(LEGACY_ATTACHMENT_PREFIX)) {
    try {
      const legacy = JSON.parse(raw);
      return createMediaEnvelope(mediaTypeForMime(legacy.mimeType), {
        id: legacy.id,
        key: legacy.key,
        iv: legacy.iv,
        filename: legacy.filename,
        mimeType: legacy.mimeType,
        chunked: Boolean(legacy.chunked),
        totalChunks: legacy.totalChunks ?? 1,
        burnOnRead: Boolean(legacy.burnOnRead),
      });
    } catch {
      return createTextEnvelope(raw);
    }
  }

  return createTextEnvelope(raw);
}

/**
 * The single entry point for turning a received payload into an envelope,
 * whatever era or chat mode it came from. Never throws: an undecodable
 * payload becomes a text envelope holding the raw string, because showing
 * something imperfect beats blanking a message.
 */
export function parseEnvelope(raw) {
  if (raw && typeof raw === 'object') {
    return raw.v === ENVELOPE_VERSION ? raw : fromLegacyPayload(JSON.stringify(raw));
  }
  if (typeof raw !== 'string') return createTextEnvelope('');

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.v === ENVELOPE_VERSION) {
      return parsed;
    }
  } catch {
    // Not JSON — plain legacy text.
  }
  return fromLegacyPayload(raw);
}

/** Text to display for an envelope; media envelopes render from `media`. */
export function displayText(envelope) {
  if (!envelope) return '';
  if (envelope.t === MessageType.TEXT) return envelope.body ?? '';
  if (envelope.t === MessageType.OP) return '';
  return envelope.body ?? '';
}
