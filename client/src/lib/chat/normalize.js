// ============================================================
// Vault — Message Normalisation
// ============================================================
// Turns whatever arrived — a cloud message with plaintext columns, a secret
// message that has just been decrypted, or a legacy pre-envelope payload —
// into one shape.
//
// This is the receive-side half of the dual-mode fork. It exists so that
// exactly one place in the client knows there are two kinds of message; the
// message list, the bubble and the store all consume a single shape and never
// branch on mode themselves. Without it, every consumer grows its own
// `if (message.encrypted)` and the fork leaks across the whole UI.

import { parseEnvelope, displayText, MessageType } from '$shared/envelope.js';

/**
 * @param {object} raw   - a wire message from HTTP or the websocket
 * @param {object} [opts.decryptedText] - plaintext, once the ratchet has run
 * @returns a message the UI can render without knowing its mode
 */
export function normalizeMessage(raw, { decryptedText = null } = {}) {
  if (!raw) return null;

  const isCloud = raw.mode === 'cloud';

  // Cloud messages arrive already structured; secret ones arrive as a string
  // that has to be parsed back into an envelope. parseEnvelope also lifts
  // legacy payloads, so pre-envelope messages keep rendering.
  const envelope = isCloud
    ? envelopeFromColumns(raw)
    : parseEnvelope(decryptedText ?? raw.text ?? '');

  return {
    id: raw.id,
    chatId: raw.chatId ?? null,
    seq: raw.seq ?? null,
    senderId: raw.senderId,
    senderUsername: raw.senderUsername ?? null,
    mode: isCloud ? 'cloud' : 'secret',

    // `text` stays the field the existing UI reads, so this shape is a
    // superset of what components already expect rather than a rewrite.
    text: displayText(envelope),
    envelope,
    messageType: envelope.t,
    media: envelope.media,
    entities: envelope.entities ?? [],
    replyToSeq: raw.replyToSeq ?? envelope.replyTo?.seq ?? null,

    sentAt: raw.sentAt,
    expiresAt: raw.expiresAt,
    editedAt: raw.editedAt ?? null,
    pinnedAt: raw.pinnedAt ?? null,

    delivered: raw.delivered ?? false,
    read: raw.read ?? false,
    // Cloud messages are never in an encrypted state; a secret one is until
    // its ratchet has run.
    encrypted: isCloud ? false : Boolean(raw.encrypted),
    decryptionError: raw.decryptionError ?? false,
  };
}

function envelopeFromColumns(raw) {
  return {
    v: 1,
    t: raw.messageType || MessageType.TEXT,
    body: raw.body ?? null,
    entities: raw.entities ?? [],
    media: raw.media ?? null,
    replyTo: raw.replyToSeq ? { chatId: raw.chatId, seq: raw.replyToSeq } : null,
    fwd: null,
    groupedId: raw.groupedId ?? null,
    ttl: null,
    op: null,
  };
}
