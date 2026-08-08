// ============================================================
// Vault — Message Send Path
// ============================================================
// Encrypts a payload and dispatches it, for both 1:1 and group conversations.
//
// This is the most consequential ~250 lines in the client and it lived in the
// middle of a 2000-line component. It contains the Signal Sender Key
// distribution protocol: deciding which group members still need our sender
// key, encrypting that key to each of them over their pairwise ratchet, and
// only then encrypting the actual message once for the whole group. Get the
// distribution step wrong and messages still send — they just cannot be read
// by anyone who joined after the last distribution.
//
// It is extracted here rather than left in place because this is where the
// cloud/secret fork lands in Phase 1: `sendMessage(chat, envelope)` will
// branch on `chat.mode`, calling this function for secret chats and a plain
// HTTP POST for cloud ones, with everything upstream — composer, attachment
// picker, reply state — staying mode-agnostic.
//
// The `context` argument carries what used to be component scope: the peer
// (or group) being sent to, the local user, and the send TTL.

import { get } from 'svelte/store';

import { historyKey, groupSenderKeys, groupKeyRecipients } from '../stores/session.js';
import { addOptimisticMessage, confirmMessage, markMessageFailed, conversations } from '../stores/messages.js';
import { sendMessage as postEncryptedMessage } from '../api/http.js';
import { SenderKeySession } from '../crypto/senderkeys.js';
import { encrypt as encryptSelf } from '../crypto/keys.js';
import { randomHex } from '../crypto/utils.js';
import { syncCloudVault } from '../crypto/sync.js';
import { sendCloudMessage } from '../api/http.js';
import { getOrCreateRatchetForUser } from './sessions.js';
import { capabilities } from '$shared/capabilities.js';
import { MessageType, displayText, serializeEnvelope } from '$shared/envelope.js';

export async function encryptAndSend(text, isAttachment = false, context = {}) {
  const { peer, currentUser: me, ttlMinutes } = context;
  const tempId = `temp-${randomHex(8)}`;

  let attachmentId = null;
  if (isAttachment) {
    try {
      const parsed = JSON.parse(text);
      attachmentId = parsed.id;
    } catch (err) {}
  }

  addOptimisticMessage(peer.id, {
    id: tempId,
    senderId: me.id,
    // `text` may be a serialised envelope (a reply, or an op). Store the
    // human-readable body so the sender's own bubble does not show JSON while
    // the message is in flight.
    text: context.displayText ?? text,
    // Present for sends that came through sendMessage(). Lets the sender's
    // own bubble render structured payloads — a sticker most visibly — the
    // same way the received copy will.
    envelope: context.envelope ?? null,
    messageType: context.envelope?.t ?? null,
    media: context.envelope?.media ?? null,
    replyToSeq: context.replyToSeq ?? null,
    encrypted: false,
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
  });

  // Not re-indented below — this wraps the existing group/1:1 send logic
  // wholesale so any thrown error (network failure, the "all group members
  // failed" throw a few dozen lines down, etc.) marks the optimistic bubble
  // failed instead of leaving it stuck on its "sending" spinner forever,
  // which is what happened before: confirmMessage() is only ever reached on
  // success, and nothing else in this path used to touch the message on
  // failure at all.
  try {
  if (peer.isGroup) {
    // 1. Get or create our own Sender Key for this group
    const mySessionKey = `${peer.id}:${me.id}`;
    let mySession = get(groupSenderKeys).get(mySessionKey);
    if (!mySession) {
      mySession = new SenderKeySession(me.id, peer.id);
      await mySession.initSelf();
      groupSenderKeys.update(m => { m.set(mySessionKey, mySession); return m; });
    }

    const otherMembers = peer.members.filter(m => m.id !== me.id);

    // 2. Distribute our Sender Key to any current member who doesn't have it yet
    // (new session, or a member who joined after we last distributed) — not just
    // the first time we ever create a session for this group.
    const alreadySent = get(groupKeyRecipients).get(mySessionKey) || new Set();
    const pendingMembers = otherMembers.filter(m => !alreadySent.has(m.id));

    if (pendingMembers.length > 0) {
      const pack = await mySession.exportDistributionPackage();
      const distributionPayload = JSON.stringify({
        type: 'senderkey_distribution',
        groupId: peer.id,
        pack
      });

      await Promise.all(pendingMembers.map(async (member) => {
        try {
          const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser(member.id, member.username);
          const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(distributionPayload);

          let selfCiphertext = null;
          let selfIv = null;
          const _hk = get(historyKey);
          if (_hk) {
            const encSelf = await encryptSelf(_hk, distributionPayload);
            selfCiphertext = encSelf.ciphertext;
            selfIv = encSelf.iv;
          }

          const packagedCiphertext = btoa(JSON.stringify({
            bob: { ct: ciphertext, iv: iv },
            self: { ct: selfCiphertext, iv: selfIv }
          }));

          const packagedEphemeralHeader = JSON.stringify(isNew ? {
            type: 'x3dh',
            ik: x3dhParams.ik,
            ek: x3dhParams.ek,
            opk: x3dhParams.opk,
            rk: header.publicKey
          } : {
            type: 'ratchet',
            rk: header.publicKey
          });

          await postEncryptedMessage({
            recipientId: member.id,
            ciphertext: packagedCiphertext,
            ephemeralKey: packagedEphemeralHeader,
            messageNumber: header.messageNumber,
            previousChain: header.previousChainLength,
            ttlMinutes,
            iv: iv,
            groupId: peer.id.replace('group-', '')
          });

          groupKeyRecipients.update(m => {
            const set = m.get(mySessionKey) || new Set();
            set.add(member.id);
            m.set(mySessionKey, set);
            return m;
          });
        } catch (e) {
          console.error(`Failed to distribute group Sender Key to ${member.username}:`, e);
        }
      }));
    }

    // 3. Encrypt the group message payload ONCE using the Sender Key
    const packet = await mySession.encrypt(text);

    let selfCiphertext = null;
    let selfIv = null;
    const _hk = get(historyKey);
    if (_hk) {
      const encSelf = await encryptSelf(_hk, text);
      selfCiphertext = encSelf.ciphertext;
      selfIv = encSelf.iv;
    }

    const packagedCiphertext = btoa(JSON.stringify({
      bob: {
        ct: packet.ciphertext,
        iv: packet.iv,
        senderKey: {
          messageNumber: packet.messageNumber,
          signature: packet.signature,
          groupId: packet.groupId,
          senderId: packet.senderId
        }
      },
      self: { ct: selfCiphertext, iv: selfIv }
    }));

    // 4. Dispatch the encrypted ciphertext to all group members
    const sendPromises = otherMembers.map(async (member) => {
      try {
        return await postEncryptedMessage({
          recipientId: member.id,
          ciphertext: packagedCiphertext,
          ephemeralKey: JSON.stringify({ type: 'senderkey' }),
          messageNumber: packet.messageNumber,
          previousChain: 0,
          ttlMinutes,
          iv: packet.iv,
          groupId: peer.id.replace('group-', ''),
          // Only send the key when there actually is an attachment — an
          // explicit null is rejected by the server's UUID validation.
          ...(attachmentId ? { attachmentId } : {})
        });
      } catch (e) {
        console.error(`Failed to send SenderKey group message to ${member.username}:`, e);
      }
    });

    const results = await Promise.all(sendPromises);
    const successResult = results.find(r => r !== undefined);

    if (!successResult && otherMembers.length > 0) {
      throw new Error('Failed to send group message.');
    }

    // Best-effort cloud backup — must never cause the message/attachment
    // itself (already successfully sent above) to be reported as failed.
    try {
      await syncCloudVault();
    } catch (syncErr) {
      console.error('Cloud vault sync failed after send:', syncErr);
    }

    // No other members to deliver to (e.g. you're the sole remaining
    // member of the group) — confirm locally using the optimistic values
    // instead of a server-assigned id/timestamp.
    const confirmedAt = successResult ? successResult.sentAt : new Date().toISOString();
    confirmMessage(peer.id, tempId, {
      id: successResult ? successResult.id : tempId,
      chatId: successResult ? successResult.chatId : null,
      seq: successResult ? successResult.seq : null,
      sentAt: confirmedAt,
      expiresAt: successResult ? successResult.expiresAt : new Date(Date.now() + ttlMinutes * 60000).toISOString(),
      delivered: true
    });

    conversations.update(convs => {
      const existing = convs.find(c => c.peerId === peer.id);
      if (existing) {
        existing.lastMessageAt = confirmedAt;
        const idx = convs.indexOf(existing);
        if (idx > 0) {
          convs.splice(idx, 1);
          convs.unshift(existing);
        }
      }
      return [...convs];
    });

  } else {
    const { ratchet, isNew, x3dhParams } = await getOrCreateRatchetForUser(peer.id, peer.username);
    const { header, iv, ciphertext } = await ratchet.ratchetEncrypt(text);

    let selfCiphertext = null;
    let selfIv = null;
    const _hk = get(historyKey);
    if (_hk) {
      const encSelf = await encryptSelf(_hk, text);
      selfCiphertext = encSelf.ciphertext;
      selfIv = encSelf.iv;
    }

    const packagedCiphertext = btoa(JSON.stringify({
      bob: { ct: ciphertext, iv: iv },
      self: { ct: selfCiphertext, iv: selfIv }
    }));

    const packagedEphemeralHeader = JSON.stringify(isNew ? {
      type: 'x3dh',
      ik: x3dhParams.ik,
      ek: x3dhParams.ek,
      opk: x3dhParams.opk,
      rk: header.publicKey
    } : {
      type: 'ratchet',
      rk: header.publicKey
    });

    const result = await postEncryptedMessage({
      recipientId: peer.id,
      // Names the chat so the server allocates a per-chat seq. Without it a
      // secret message has no address, and nothing can reference it —
      // reactions and replies simply never offer themselves.
      chatId: context.chatId || peer.chatId || null,
      ciphertext: packagedCiphertext,
      ephemeralKey: packagedEphemeralHeader,
      messageNumber: header.messageNumber,
      previousChain: header.previousChainLength,
      ttlMinutes,
      iv: iv,
      ...(attachmentId ? { attachmentId } : {})
    });

    // Best-effort cloud backup — must never cause the message/attachment
    // itself (already successfully sent above) to be reported as failed.
    try {
      await syncCloudVault();
    } catch (syncErr) {
      console.error('Cloud vault sync failed after send:', syncErr);
    }

    confirmMessage(peer.id, tempId, {
      id: result.id,
      // chatId/seq are what make this message addressable. Without them a
      // reaction or reply can never find it in the store — the lookup by seq
      // silently misses and nothing renders.
      chatId: result.chatId,
      seq: result.seq,
      sentAt: result.sentAt,
      expiresAt: result.expiresAt,
      delivered: result.delivered
    });

    conversations.update(convs => {
      const existing = convs.find(c => c.peerId === peer.id);
      if (existing) {
        existing.lastMessageAt = result.sentAt;
        const idx = convs.indexOf(existing);
        if (idx > 0) {
          convs.splice(idx, 1);
          convs.unshift(existing);
        }
      }
      return [...convs];
    });
  }
  } catch (err) {
    markMessageFailed(peer.id, tempId);
    throw err;
  }
}

// ============================================================
// The dual-mode fork
// ============================================================
// One entry point. Everything upstream of it — the composer, the attachment
// picker, reply and forward state — is mode-agnostic and stays that way; only
// this function knows there are two kinds of chat.
//
//   secret → encrypt through X3DH/Double Ratchet (or Sender Keys for a
//            group) and post ciphertext. The server stores a blob it cannot
//            read, exactly as it always has.
//   cloud  → post the envelope's fields as plaintext columns, so the server
//            can search them, unfurl their links, and replay them to another
//            device that holds no keys.
//
// Both produce the same in-memory message shape, which is what lets one
// message list and one composer serve both modes.

/**
 * Sends an envelope to a chat.
 *
 * @param {object} chat     - must carry `id` and `mode`
 * @param {object} envelope - see shared/envelope.js
 * @param {object} context  - { currentUser, ttlMinutes } for the secret path
 */
export async function sendMessage(chat, envelope, context = {}) {
  if (!chat || !chat.id) throw new Error('sendMessage requires a chat');

  return capabilities(chat).isCloud
    ? sendCloud(chat, envelope, context)
    : sendSecret(chat, envelope, context);
}

// Secret path. The envelope is serialised and that string becomes the ratchet
// plaintext — the only change from the pre-envelope behaviour, where a bare
// string was encrypted directly.
async function sendSecret(chat, envelope, context) {
  const isAttachment = envelope.t !== MessageType.TEXT && envelope.media !== null;

  // Anything carrying structure beyond a plain body must travel as the
  // serialised envelope, or that structure is silently dropped: an op would
  // be encrypted as an empty message (displayText returns '' for one), and a
  // reply would arrive as ordinary text with no idea what it answered.
  //
  // A plain text message is still sent bare, so messages from this build stay
  // readable by clients that predate the envelope. parseEnvelope() on the
  // receiving side handles both shapes.
  const carriesStructure =
    envelope.t === MessageType.OP
    || Boolean(envelope.replyTo)
    || Boolean(envelope.entities?.length)
    || Boolean(envelope.fwd)
    // An album's members are only recognisable as one by their shared id, so
    // dropping it turns the album back into loose files.
    || Boolean(envelope.groupedId)
    // A sticker has no body and the legacy attachment shape has no way to
    // say "sticker", so without this it arrives as a generic file.
    || envelope.t === MessageType.STICKER
    // Same problem as the sticker case: the legacy shape below spreads only
    // envelope.media, nothing else, so a caption on a lone attachment would
    // otherwise be silently dropped rather than just not sent.
    || (isAttachment && Boolean(envelope.body));

  const payload = carriesStructure
    ? serializeEnvelope(envelope)
    : isAttachment
      ? JSON.stringify({ type: 'attachment', ...envelope.media })
      : displayText(envelope);

  return encryptAndSend(payload, isAttachment, {
    ...context,
    peer: context.peer || chat,
    replyToSeq: envelope.replyTo?.seq ?? null,
    displayText: displayText(envelope),
    envelope,
  });
}

// Cloud path. No encryption, because the point of this mode is that the
// server can read the content — that is what buys search, link previews and
// sync to a device with no keys. The TTL is still clamped server-side; the
// 24h rule applies here exactly as it does to a secret chat.
async function sendCloud(chat, envelope, context = {}) {
  // The message store is keyed by the UI's conversation key (a peer user id,
  // or 'group-<id>'), not by chat id — so the caller passes the peer through.
  // Without the optimistic insert below the sender's own message simply never
  // appears until a reload, which is exactly what the E2E caught.
  const storeKey = context.peer?.id || chat.id;
  const tempId = `temp-${randomHex(8)}`;
  // Doubles as the server's idempotency key and as the tag that lets the
  // store recognise the broadcast of this very message — which arrives over
  // the socket and can beat the HTTP response back.
  const clientRandomId = randomInt53();

  addOptimisticMessage(storeKey, {
    id: tempId,
    clientRandomId,
    // Carried so the sender's own copy renders the same way the confirmed
    // one will. Without it a sticker or any other body-less media type shows
    // as an empty bubble until a refetch.
    envelope,
    messageType: envelope.t,
    media: envelope.media,
    viewOnce: envelope.viewOnce || false,
    groupedId: envelope.groupedId ?? null,
    senderId: context.currentUser?.id,
    text: displayText(envelope),
    replyToSeq: envelope.replyTo?.seq ?? null,
    encrypted: false,
    mode: 'cloud',
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (envelope.ttl ?? 86400) * 1000).toISOString(),
  });

  let stored;
  try {
    stored = await sendCloudMessage(chat.id, {
      type: envelope.t,
      body: envelope.body,
      entities: envelope.entities?.length ? envelope.entities : null,
      media: envelope.media,
      replyToSeq: envelope.replyTo?.seq ?? null,
      groupedId: envelope.groupedId,
      ttlSeconds: envelope.ttl,
      clientRandomId,
      viewOnce: envelope.viewOnce || false,
      // Present only in a forum group with a topic selected; omitted, the
      // message belongs to the chat as a whole.
      topicId: context.topicId ?? null,
    });
  } catch (err) {
    // Otherwise the optimistic bubble above is stuck on its "sending"
    // spinner forever — confirmMessage() below is the only thing that ever
    // touched it again, and that only runs on success.
    markMessageFailed(storeKey, tempId);
    throw err;
  }

  confirmMessage(storeKey, tempId, {
    id: stored.id,
    chatId: stored.chatId,
    seq: stored.seq,
    replyToSeq: envelope.replyTo?.seq ?? null,
    sentAt: stored.sentAt,
    expiresAt: stored.expiresAt,
    delivered: true,
  });

  conversations.update((convs) => {
    const existing = convs.find((c) => c.peerId === storeKey);
    if (existing) {
      existing.lastMessageAt = stored.sentAt;
      existing.isEmpty = false;
      const idx = convs.indexOf(existing);
      if (idx > 0) {
        convs.splice(idx, 1);
        convs.unshift(existing);
      }
    }
    return [...convs];
  });

  return {
    id: stored.id,
    chatId: stored.chatId,
    seq: stored.seq,
    senderId: stored.senderId,
    text: stored.body,
    media: stored.media,
    sentAt: stored.sentAt,
    expiresAt: stored.expiresAt,
    encrypted: false,
    mode: 'cloud',
  };
}

// Idempotency token for a send. Kept inside 53 bits so it survives JSON round
// trips intact — a bigint here would be silently mangled and the retry would
// no longer match the original.
function randomInt53() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

// Exposed for tests and for callers that already hold a serialised envelope.
export { serializeEnvelope };
