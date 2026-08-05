import { describe, test, expect } from 'vitest';

import {
  ENVELOPE_VERSION,
  MessageType,
  OpKind,
  createEnvelope,
  createTextEnvelope,
  createMediaEnvelope,
  createOpEnvelope,
  isOp,
  isMedia,
  serializeEnvelope,
  parseEnvelope,
  isLegacyPayload,
  fromLegacyPayload,
  displayText,
} from '../../shared/envelope.js';

describe('envelope construction', () => {
  test('a text envelope has every field consumers rely on', () => {
    const env = createTextEnvelope('hello');

    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.t).toBe(MessageType.TEXT);
    expect(env.body).toBe('hello');
    expect(env.entities).toEqual([]);
    expect(env.media).toBeNull();
    expect(env.replyTo).toBeNull();
    expect(env.op).toBeNull();
  });

  test('rejects an unknown message type', () => {
    expect(() => createEnvelope({ t: 'telepathy' })).toThrow(/unknown message type/i);
  });

  test("an 'op' envelope must carry an op", () => {
    expect(() => createEnvelope({ t: MessageType.OP })).toThrow(/must carry an op/i);
  });

  test('rejects an unknown op kind', () => {
    expect(() => createOpEnvelope({ kind: 'levitate' })).toThrow(/unknown op kind/i);
  });

  test('carries reply, forward and grouping metadata', () => {
    const env = createTextEnvelope('re: that', {
      replyTo: { chatId: 'c1', seq: 7 },
      fwd: { chatId: 'c0', seq: 2, name: 'alice', date: 123 },
      groupedId: 'album-1',
      ttl: 300,
    });

    expect(env.replyTo).toEqual({ chatId: 'c1', seq: 7 });
    expect(env.fwd.name).toBe('alice');
    expect(env.groupedId).toBe('album-1');
    expect(env.ttl).toBe(300);
  });
});

describe('operations', () => {
  test('a reaction is an op envelope', () => {
    const env = createOpEnvelope({ kind: OpKind.REACT, seq: 12, emoji: '🔥' });

    expect(env.t).toBe(MessageType.OP);
    expect(isOp(env)).toBe(true);
    expect(isOp(env, OpKind.REACT)).toBe(true);
    expect(isOp(env, OpKind.DELETE)).toBe(false);
  });

  test('every op kind round-trips through serialisation', () => {
    // In a secret chat this string is the ratchet plaintext, so anything that
    // does not survive the round trip cannot be applied on receipt.
    for (const kind of Object.values(OpKind)) {
      const env = createOpEnvelope({ kind, seq: 1 });
      const back = parseEnvelope(serializeEnvelope(env));
      expect(isOp(back, kind)).toBe(true);
    }
  });

  test('a text envelope is not an op', () => {
    expect(isOp(createTextEnvelope('hi'))).toBe(false);
    expect(isOp(null)).toBe(false);
  });

  test('ops render no display text', () => {
    expect(displayText(createOpEnvelope({ kind: OpKind.PIN, seq: 3 }))).toBe('');
  });
});

describe('media envelopes', () => {
  const media = { id: 'a1', key: 'k', iv: 'i', filename: 'f.png', mimeType: 'image/png' };

  test('are recognised as media', () => {
    expect(isMedia(createMediaEnvelope(MessageType.PHOTO, media))).toBe(true);
    expect(isMedia(createMediaEnvelope(MessageType.VOICE, media))).toBe(true);
    expect(isMedia(createTextEnvelope('hi'))).toBe(false);
    expect(isMedia(null)).toBe(false);
  });

  test('survive a serialise/parse round trip', () => {
    const env = createMediaEnvelope(MessageType.DOCUMENT, media);
    const back = parseEnvelope(serializeEnvelope(env));

    expect(back.t).toBe(MessageType.DOCUMENT);
    expect(back.media).toEqual(media);
  });
});

describe('legacy interop', () => {
  // Exactly the payload ChatView.svelte produced before the envelope existed.
  const legacyAttachment = JSON.stringify({
    type: 'attachment',
    id: 'att-1',
    key: 'base64key',
    iv: 'base64iv',
    filename: 'photo.png',
    mimeType: 'image/png',
    chunked: true,
    totalChunks: 3,
    burnOnRead: true,
  });

  const legacyVoiceNote = JSON.stringify({
    type: 'attachment',
    id: 'att-2',
    key: 'k',
    iv: 'i',
    filename: 'voicenote.webm',
    mimeType: 'audio/webm',
    burnOnRead: false,
  });

  test('detects legacy payloads', () => {
    expect(isLegacyPayload(legacyAttachment)).toBe(true);
    expect(isLegacyPayload('just some text')).toBe(true);
    expect(isLegacyPayload(serializeEnvelope(createTextEnvelope('hi')))).toBe(false);
  });

  test('a legacy image attachment becomes a photo envelope', () => {
    const env = fromLegacyPayload(legacyAttachment);

    expect(env.t).toBe(MessageType.PHOTO);
    expect(env.media.id).toBe('att-1');
    expect(env.media.chunked).toBe(true);
    expect(env.media.totalChunks).toBe(3);
    expect(env.media.burnOnRead).toBe(true);
  });

  test('a legacy voice note becomes a voice envelope', () => {
    const env = fromLegacyPayload(legacyVoiceNote);

    expect(env.t).toBe(MessageType.VOICE);
    expect(env.media.filename).toBe('voicenote.webm');
    expect(env.media.burnOnRead).toBe(false);
  });

  test('a legacy non-media mime type becomes a document', () => {
    const env = fromLegacyPayload(JSON.stringify({
      type: 'attachment', id: 'x', key: 'k', iv: 'i',
      filename: 'notes.pdf', mimeType: 'application/pdf',
    }));
    expect(env.t).toBe(MessageType.DOCUMENT);
  });

  test('bare legacy text becomes a text envelope', () => {
    const env = fromLegacyPayload('hello from before');
    expect(env.t).toBe(MessageType.TEXT);
    expect(env.body).toBe('hello from before');
  });
});

describe('parseEnvelope robustness', () => {
  test('passes a current envelope straight through', () => {
    const env = createTextEnvelope('current');
    expect(parseEnvelope(serializeEnvelope(env))).toEqual(env);
  });

  test('accepts an already-parsed object', () => {
    const env = createTextEnvelope('object form');
    expect(parseEnvelope(env)).toEqual(env);
  });

  test('never throws on junk input', () => {
    // A message that cannot be decoded must still render as something rather
    // than blanking or crashing the list.
    for (const input of ['', '{', 'null', '[]', '{"v":999}', undefined, null, 42, {}]) {
      expect(() => parseEnvelope(input)).not.toThrow();
      expect(parseEnvelope(input).v).toBe(ENVELOPE_VERSION);
    }
  });

  test('a JSON string that is not an envelope is treated as text', () => {
    const env = parseEnvelope('{"something":"else"}');
    expect(env.t).toBe(MessageType.TEXT);
    expect(env.body).toBe('{"something":"else"}');
  });

  test('text containing the legacy prefix as content is not misread', () => {
    // The old sniff would have mistaken this for an attachment.
    const tricky = 'look at this: {"type":"attachment" — weird right?';
    const env = parseEnvelope(serializeEnvelope(createTextEnvelope(tricky)));

    expect(env.t).toBe(MessageType.TEXT);
    expect(env.body).toBe(tricky);
    expect(isMedia(env)).toBe(false);
  });
});

describe('displayText', () => {
  test('returns the body for text', () => {
    expect(displayText(createTextEnvelope('shown'))).toBe('shown');
  });

  test('is empty for a media envelope with no caption', () => {
    expect(displayText(createMediaEnvelope(MessageType.PHOTO, { id: 'x' }))).toBe('');
  });

  test('tolerates null', () => {
    expect(displayText(null)).toBe('');
  });
});
