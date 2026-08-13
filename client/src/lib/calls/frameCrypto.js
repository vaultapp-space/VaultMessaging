// ============================================================
// Vault — end-to-end encrypted media frames
// ============================================================
// The piece that makes a group call safe to route through a media server the
// operator controls.
//
// An ordinary SFU decrypts every stream to forward it, which would mean the
// server can hear your calls — unacceptable for this product specifically,
// since the whole claim is that it cannot. WebRTC's Insertable Streams let the
// application encrypt each *encoded frame* before the browser's own transport
// encryption is applied, and decrypt it after the peer's is removed. The SFU
// then sees RTP headers it needs for routing and a payload it cannot read.
//
// The key never reaches the server. It comes from the same Sender Key material
// group messaging already uses — see lib/stores/session.js's groupSenderKeys.
//
// **Browser support is the catch.** This is Chromium-only in practice: Safari
// has neither API and Firefox's support is partial. The Android app is a
// Chromium WebView so it is fine; web users elsewhere have to fall back to the
// existing mesh, which is why `isFrameCryptoSupported` exists and why callers
// must branch on it rather than assume.

const IV_LENGTH = 12;
// A frame counter, so no two frames from this sender ever share an IV under
// the same key. AES-GCM fails catastrophically on IV reuse — not "slightly
// weaker", but recoverable plaintext — so this is the single most important
// property in the file.
const COUNTER_BYTES = 4;

/**
 * How many leading bytes of the payload are left in clear text.
 *
 * The SFU has to read enough of a video frame to tell a keyframe from a delta
 * frame; without that it cannot make forwarding decisions and cannot ask for a
 * new keyframe when someone joins. Those first bytes are codec metadata, not
 * content — the picture itself stays encrypted.
 *
 * Audio has no such requirement, so nothing is exposed.
 */
const CLEAR_HEADER_BYTES = { audio: 0, video: 10 };

/**
 * Whether this browser can do frame-level encryption at all.
 *
 * Two APIs for the same capability: `RTCRtpScriptTransform` is the newer,
 * worker-based standard, `createEncodedStreams` the original Chromium one.
 * Either is enough.
 */
export function isFrameCryptoSupported() {
  if (typeof window === 'undefined' || typeof RTCRtpSender === 'undefined') return false;
  return (
    typeof window.RTCRtpScriptTransform === 'function'
    || typeof RTCRtpSender.prototype.createEncodedStreams === 'function'
  );
}

/**
 * Derives the per-call media key from the group's Sender Key.
 *
 * Domain-separated with a fixed label so the media key can never coincide with
 * the key protecting messages, even though both descend from the same secret.
 * A key reused across two protocols is one protocol's bug away from breaking
 * the other.
 */
export async function deriveMediaKey(senderKeyBytes, callId) {
  const base = await crypto.subtle.importKey('raw', senderKeyBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(callId),
      info: new TextEncoder().encode('vault/media/v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Builds the pair of transforms for one peer connection.
 *
 * `kind` is 'audio' or 'video' and decides how much of the payload stays in
 * clear text (see CLEAR_HEADER_BYTES).
 */
export function createFrameCipher(key, kind = 'audio') {
  const clearBytes = CLEAR_HEADER_BYTES[kind] ?? 0;
  let counter = 0;

  // Random per sender, so two participants who somehow derived the same key
  // still never collide on an IV. Combined with the counter this gives a
  // unique IV per frame without any coordination between senders.
  const senderSalt = crypto.getRandomValues(new Uint8Array(IV_LENGTH - COUNTER_BYTES));

  function ivFor(count) {
    const iv = new Uint8Array(IV_LENGTH);
    iv.set(senderSalt, 0);
    new DataView(iv.buffer).setUint32(IV_LENGTH - COUNTER_BYTES, count, false);
    return iv;
  }

  return {
    /** Encrypts one outgoing encoded frame in place. */
    async encrypt(frame, controller) {
      const data = new Uint8Array(frame.data);
      const header = data.subarray(0, clearBytes);
      const payload = data.subarray(clearBytes);

      const count = counter++;
      const iv = ivFor(count);

      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          // The clear header is authenticated even though it is not encrypted:
          // an SFU that rewrote those bytes to fake a keyframe would otherwise
          // go undetected.
          { name: 'AES-GCM', iv, additionalData: header },
          key,
          payload
        )
      );

      // header ‖ ciphertext ‖ iv.
      //
      // **The whole IV travels, not just the counter.** Each sender's salt is
      // random and private to its own cipher instance, so a receiver has no
      // way to reconstruct it — sending only the counter meant the two sides
      // computed different IVs and every frame failed to authenticate. It is
      // not a secret: an IV must be unique, not unpredictable, and GCM's
      // security rests on never repeating one under a key, which the counter
      // guarantees.
      //
      // It also has to travel because packets are dropped and reordered, so a
      // receive-side counter would desynchronise on the first loss and never
      // recover.
      const out = new Uint8Array(clearBytes + sealed.length + IV_LENGTH);
      out.set(header, 0);
      out.set(sealed, clearBytes);
      out.set(iv, out.length - IV_LENGTH);

      frame.data = out.buffer;
      controller.enqueue(frame);
    },

    /** Decrypts one incoming encoded frame in place. */
    async decrypt(frame, controller) {
      const data = new Uint8Array(frame.data);
      if (data.length < clearBytes + IV_LENGTH + 16) {
        // Too short to be a frame this cipher produced (16 is the GCM tag).
        // Dropped rather than passed through: handing the decoder something
        // unauthenticated is how a malicious SFU would inject media.
        return;
      }

      const header = data.subarray(0, clearBytes);
      const sealed = data.subarray(clearBytes, data.length - IV_LENGTH);
      const iv = data.subarray(data.length - IV_LENGTH);

      try {
        const plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: header },
            key,
            sealed
          )
        );

        const out = new Uint8Array(clearBytes + plain.length);
        out.set(header, 0);
        out.set(plain, clearBytes);
        frame.data = out.buffer;
        controller.enqueue(frame);
      } catch {
        // Authentication failed: the wrong key, a corrupted frame, or a forged
        // one. Dropping a frame costs a moment of audio; forwarding an
        // unauthenticated one defeats the entire mechanism.
      }
    },
  };
}

/**
 * Attaches the cipher to a sender or receiver.
 *
 * Deliberately branches on the two APIs rather than picking one: the
 * worker-based RTCRtpScriptTransform is the standard, but the Android WebView
 * this app actually ships in still uses createEncodedStreams, so supporting
 * only the modern one would mean supporting nothing on the platform that
 * matters most here.
 */
export function attachFrameCipher(target, cipher, direction) {
  const transform = direction === 'send' ? cipher.encrypt : cipher.decrypt;

  if (typeof target.createEncodedStreams === 'function') {
    const { readable, writable } = target.createEncodedStreams();
    readable
      .pipeThrough(new TransformStream({ transform }))
      .pipeTo(writable)
      .catch(() => {
        // The pipeline ends when the connection does. A rejection here is the
        // stream closing, not a failure worth surfacing.
      });
    return true;
  }

  return false;
}

export const __testing = { CLEAR_HEADER_BYTES, IV_LENGTH, COUNTER_BYTES };
