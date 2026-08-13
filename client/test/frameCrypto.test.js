import { describe, test, expect } from 'vitest';
import { webcrypto } from 'node:crypto';

import {
  createFrameCipher, deriveMediaKey, isFrameCryptoSupported, __testing,
} from '../src/lib/calls/frameCrypto.js';

// Node exposes WebCrypto under a different global than a browser does.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

// A stand-in for an encoded media frame. The real object is an
// RTCEncodedAudioFrame, but the transform only ever touches `.data`.
function frame(bytes) {
  return { data: new Uint8Array(bytes).buffer };
}

function collect() {
  const out = [];
  return { enqueue: (f) => out.push(f), out };
}

async function key() {
  return deriveMediaKey(new Uint8Array(32).fill(7), 'call-123');
}

describe('frame crypto', () => {
  test('a frame survives a round trip unchanged', async () => {
    const k = await key();
    const send = createFrameCipher(k, 'audio');
    const receive = createFrameCipher(k, 'audio');
    const original = [1, 2, 3, 4, 5, 6, 7, 8];

    const sent = collect();
    await send.encrypt(frame(original), sent);

    const got = collect();
    await receive.decrypt(sent.out[0], got);

    expect([...new Uint8Array(got.out[0].data)]).toEqual(original);
  });

  test('the payload is genuinely unreadable in transit', async () => {
    // The point of the whole exercise: what the SFU holds must not contain the
    // plaintext.
    const k = await key();
    const send = createFrameCipher(k, 'audio');
    const plaintext = [9, 9, 9, 9, 9, 9, 9, 9];

    const sent = collect();
    await send.encrypt(frame(plaintext), sent);
    const onWire = [...new Uint8Array(sent.out[0].data)];

    expect(onWire).not.toEqual(plaintext);
    expect(onWire.length).toBeGreaterThan(plaintext.length); // GCM tag + counter
  });

  test('a different key cannot decrypt, and the frame is dropped not forwarded', async () => {
    // Dropping matters as much as failing: handing the decoder an
    // unauthenticated frame is how a malicious SFU would inject media.
    const send = createFrameCipher(await key(), 'audio');
    const wrong = createFrameCipher(
      await deriveMediaKey(new Uint8Array(32).fill(8), 'call-123'), 'audio'
    );

    const sent = collect();
    await send.encrypt(frame([1, 2, 3, 4]), sent);

    const got = collect();
    await wrong.decrypt(sent.out[0], got);

    expect(got.out).toHaveLength(0);
  });

  test('a key derived for another call cannot decrypt this one', async () => {
    // The callId is the HKDF salt, so a recorded frame replayed into a
    // different call is unreadable there.
    const send = createFrameCipher(await key(), 'audio');
    const otherCall = createFrameCipher(
      await deriveMediaKey(new Uint8Array(32).fill(7), 'call-999'), 'audio'
    );

    const sent = collect();
    await send.encrypt(frame([1, 2, 3, 4]), sent);

    const got = collect();
    await otherCall.decrypt(sent.out[0], got);
    expect(got.out).toHaveLength(0);
  });

  test('every frame gets a distinct IV', async () => {
    // AES-GCM under a reused IV does not degrade gracefully — it leaks
    // plaintext. The counter is what prevents it, and it travels in the frame
    // because packets are lost and reordered, so a receive-side counter would
    // desynchronise permanently on the first drop.
    const send = createFrameCipher(await key(), 'audio');
    const sent = collect();

    for (let i = 0; i < 50; i += 1) await send.encrypt(frame([1, 2, 3, 4]), sent);

    // The trailing 12 bytes are the IV. Every one must differ.
    const ivs = sent.out.map((f) => {
      const d = new Uint8Array(f.data);
      return [...d.subarray(d.length - __testing.IV_LENGTH)].join(',');
    });
    expect(new Set(ivs).size).toBe(50);

    // And identical plaintext must not produce identical ciphertext.
    const bodies = sent.out.map((f) => [...new Uint8Array(f.data)].join(','));
    expect(new Set(bodies).size).toBe(50);
  });

  test('frames decrypt out of order, because packets arrive that way', async () => {
    const k = await key();
    const send = createFrameCipher(k, 'audio');
    const receive = createFrameCipher(k, 'audio');

    const sent = collect();
    await send.encrypt(frame([1]), sent);
    await send.encrypt(frame([2]), sent);
    await send.encrypt(frame([3]), sent);

    const got = collect();
    await receive.decrypt(sent.out[2], got);
    await receive.decrypt(sent.out[0], got);

    expect(got.out.map((f) => new Uint8Array(f.data)[0])).toEqual([3, 1]);
  });

  test('video leaves a codec header in clear but authenticates it', async () => {
    // The SFU needs those bytes to tell a keyframe from a delta frame. They
    // are metadata, not picture — but they are covered by the GCM tag, so an
    // SFU that rewrites them to fake a keyframe is detected.
    const k = await key();
    const send = createFrameCipher(k, 'video');
    const receive = createFrameCipher(k, 'video');
    const original = Array.from({ length: 40 }, (_, i) => i);

    const sent = collect();
    await send.encrypt(frame(original), sent);

    const wire = new Uint8Array(sent.out[0].data);
    const clear = __testing.CLEAR_HEADER_BYTES.video;
    expect([...wire.subarray(0, clear)]).toEqual(original.slice(0, clear));

    // Tamper with the "clear" header — decryption must now fail.
    wire[0] ^= 0xff;
    const got = collect();
    await receive.decrypt({ data: wire.buffer }, got);
    expect(got.out).toHaveLength(0);
  });

  test('a truncated frame is dropped rather than passed on', async () => {
    const receive = createFrameCipher(await key(), 'audio');
    const got = collect();
    await receive.decrypt(frame([1, 2, 3]), got);
    expect(got.out).toHaveLength(0);
  });

  test('capability detection does not throw outside a browser', async () => {
    // Called on every call setup, including in environments without WebRTC.
    expect(() => isFrameCryptoSupported()).not.toThrow();
  });
});
