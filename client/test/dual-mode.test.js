import { describe, test, expect } from 'vitest';

import {
  capabilities, supports, assertSupports, ChatMode,
} from '../../shared/capabilities.js';
import { createTextEnvelope, createMediaEnvelope, MessageType } from '../../shared/envelope.js';
import { normalizeMessage, isMediaMessage } from '../src/lib/chat/normalize.js';

// ============================================================
// Capabilities
// ============================================================

describe('chat capabilities', () => {
  test('cloud chats can use server-side features', () => {
    const caps = capabilities({ mode: 'cloud' });

    expect(caps.isCloud).toBe(true);
    expect(caps.has('serverSearch')).toBe(true);
    expect(caps.has('scheduledSend')).toBe(true);
    expect(caps.has('linkPreview')).toBe(true);
    expect(caps.has('multiDeviceSync')).toBe(true);
  });

  test('secret chats cannot — the server cannot read the content', () => {
    const caps = capabilities({ mode: 'secret' });

    expect(caps.isSecret).toBe(true);
    expect(caps.has('serverSearch')).toBe(false);
    expect(caps.has('scheduledSend')).toBe(false);
    expect(caps.has('linkPreview')).toBe(false);
    expect(caps.has('bots')).toBe(false);
  });

  test('secret chats keep the features that depend on holding the keys', () => {
    const caps = capabilities({ mode: 'secret' });

    expect(caps.has('perMessageTtl')).toBe(true);
    expect(caps.has('burnOnRead')).toBe(true);
    expect(caps.has('safetyNumbers')).toBe(true);
  });

  test('cloud chats do not offer the key-bound features', () => {
    const caps = capabilities({ mode: 'cloud' });

    expect(caps.has('burnOnRead')).toBe(false);
    expect(caps.has('safetyNumbers')).toBe(false);
  });

  test('ordinary messaging works identically in both modes', () => {
    // This is what makes one composer and one message list possible.
    const universal = [
      'text', 'media', 'voiceNotes', 'reactions', 'replies', 'edit', 'delete',
      'forward', 'pin', 'drafts', 'stickers', 'typing', 'readReceipts',
      'calls', 'localSearch', 'mute', 'archive',
    ];

    for (const capability of universal) {
      expect(supports({ mode: 'cloud' }, capability), `cloud: ${capability}`).toBe(true);
      expect(supports({ mode: 'secret' }, capability), `secret: ${capability}`).toBe(true);
    }
  });

  test('an unknown or missing mode is treated as secret', () => {
    // Failing closed can only ever withhold a feature; failing open would
    // send plaintext to the server for a chat the user thinks is encrypted.
    for (const input of [undefined, null, {}, { mode: 'nonsense' }, 'garbage']) {
      expect(capabilities(input).isSecret).toBe(true);
      expect(capabilities(input).has('serverSearch')).toBe(false);
    }
  });

  test('accepts a bare mode string as well as a chat', () => {
    expect(capabilities(ChatMode.CLOUD).isCloud).toBe(true);
    expect(capabilities('secret').isSecret).toBe(true);
  });

  test('assertSupports throws with a message naming the mode', () => {
    expect(() => assertSupports({ mode: 'secret' }, 'serverSearch'))
      .toThrow(/not available in secret/i);
    expect(() => assertSupports({ mode: 'cloud' }, 'serverSearch')).not.toThrow();
  });
});

// ============================================================
// Normalisation
// ============================================================

describe('message normalisation', () => {
  test('a cloud message becomes the shared shape', () => {
    const normalized = normalizeMessage({
      id: 'm1', chatId: 'c1', seq: 4, senderId: 'u1', senderUsername: 'alice',
      mode: 'cloud', messageType: 'text', body: 'hello cloud',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      sentAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
    });

    expect(normalized.text).toBe('hello cloud');
    expect(normalized.mode).toBe('cloud');
    expect(normalized.encrypted).toBe(false);
    expect(normalized.seq).toBe(4);
    expect(normalized.entities).toHaveLength(1);
  });

  test('a decrypted secret message becomes the same shape', () => {
    const envelope = createTextEnvelope('hello secret');
    const normalized = normalizeMessage(
      { id: 'm2', senderId: 'u2', mode: 'secret', sentAt: '2026-01-01T00:00:00Z' },
      { decryptedText: JSON.stringify(envelope) }
    );

    expect(normalized.text).toBe('hello secret');
    expect(normalized.mode).toBe('secret');
    expect(normalized.messageType).toBe(MessageType.TEXT);
  });

  test('both modes produce the same field set', () => {
    // The property the UI depends on: no consumer should ever need to know
    // which mode a message came from.
    const cloud = normalizeMessage({
      id: 'a', senderId: 'u', mode: 'cloud', messageType: 'text', body: 'x',
    });
    const secret = normalizeMessage(
      { id: 'b', senderId: 'u', mode: 'secret' },
      { decryptedText: JSON.stringify(createTextEnvelope('x')) }
    );

    expect(Object.keys(cloud).sort()).toEqual(Object.keys(secret).sort());
    expect(cloud.text).toBe(secret.text);
  });

  test('cloud media survives normalisation', () => {
    const normalized = normalizeMessage({
      id: 'm3', senderId: 'u', mode: 'cloud', messageType: 'photo',
      media: { id: 'f1', mimeType: 'image/png', filename: 'a.png' },
    });

    expect(isMediaMessage(normalized)).toBe(true);
    expect(normalized.media.filename).toBe('a.png');
  });

  test('secret media survives normalisation', () => {
    const envelope = createMediaEnvelope(MessageType.VOICE, {
      id: 'f2', filename: 'voicenote.webm', mimeType: 'audio/webm',
    });
    const normalized = normalizeMessage(
      { id: 'm4', senderId: 'u', mode: 'secret' },
      { decryptedText: JSON.stringify(envelope) }
    );

    expect(isMediaMessage(normalized)).toBe(true);
    expect(normalized.messageType).toBe(MessageType.VOICE);
  });

  test('a legacy pre-envelope attachment still renders', () => {
    const legacy = JSON.stringify({
      type: 'attachment', id: 'att', key: 'k', iv: 'i',
      filename: 'old.png', mimeType: 'image/png',
    });
    const normalized = normalizeMessage(
      { id: 'm5', senderId: 'u', mode: 'secret' },
      { decryptedText: legacy }
    );

    expect(isMediaMessage(normalized)).toBe(true);
    expect(normalized.media.filename).toBe('old.png');
  });

  test('legacy bare text still renders', () => {
    const normalized = normalizeMessage(
      { id: 'm6', senderId: 'u', mode: 'secret' },
      { decryptedText: 'just text from before' }
    );
    expect(normalized.text).toBe('just text from before');
  });

  test('a reply reference is carried from either source', () => {
    const fromColumn = normalizeMessage({
      id: 'a', senderId: 'u', mode: 'cloud', messageType: 'text', body: 'x',
      chatId: 'c1', replyToSeq: 7,
    });
    const fromEnvelope = normalizeMessage(
      { id: 'b', senderId: 'u', mode: 'secret' },
      { decryptedText: JSON.stringify(createTextEnvelope('x', { replyTo: { chatId: 'c1', seq: 7 } })) }
    );

    expect(fromColumn.replyToSeq).toBe(7);
    expect(fromEnvelope.replyToSeq).toBe(7);
  });

  test('an expiry is carried through — no message is ever timeless', () => {
    const normalized = normalizeMessage({
      id: 'm7', senderId: 'u', mode: 'cloud', messageType: 'text', body: 'x',
      expiresAt: '2026-01-02T00:00:00Z',
    });
    expect(normalized.expiresAt).toBe('2026-01-02T00:00:00Z');
  });

  test('tolerates junk without throwing', () => {
    expect(normalizeMessage(null)).toBeNull();
    expect(() => normalizeMessage({ id: 'x', senderId: 'u', mode: 'secret' })).not.toThrow();
    expect(normalizeMessage({ id: 'x', senderId: 'u', mode: 'secret' }).text).toBe('');
  });

  test('an undecodable secret payload degrades to text rather than blanking', () => {
    const normalized = normalizeMessage(
      { id: 'm8', senderId: 'u', mode: 'secret' },
      { decryptedText: '{ this is not valid json' }
    );
    expect(normalized.text).toBe('{ this is not valid json');
  });
});
