// ============================================================
// Vault — In-Memory Data Store
// Drop-in replacement for PostgreSQL + Redis during prototyping.
// Same API shape, backed by Maps. Swap to real drivers later.
//
// PERFORMANCE: Uses secondary indexes for O(1) lookups instead
// of O(n) full scans on every query.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

class InMemoryStore {
  constructor() {
    // "PostgreSQL" tables
    this.users = new Map();            // id → user object
    this.usernameIndex = new Map();    // username → id
    this.prekeys = new Map();          // id → prekey object
    this.messages = new Map();         // id → message object
    this.media = new Map();            // id → media chunk object
    this.groups = new Map();           // id → group object

    // ─── Secondary Indexes (for O(1) lookups) ──────────────
    this.prekeysByUser = new Map();            // userId → [prekeyId, ...]
    this.undeliveredByRecipient = new Map();   // recipientId → Set<msgId>
    this.messagesByConversation = new Map();   // conversationKey → msgId[] (sorted desc by ts)
    this.peersByUser = new Map();              // userId → Set<peerId>
    this.mediaByMessage = new Map();           // messageId → Set<mediaId>

    // "Redis" structures
    this.sessions = new Map();         // jwtId → session data
    this.pendingQueues = new Map();    // recipientId → [{ score, messageId }]
    this.wsConnections = new Map();    // userId → Set of socket refs
    this.rateLimits = new Map();       // key → { count, resetAt }
    this.activeCalls = new Map();      // userId → peerId
  }

  // ─── Helpers ──────────────────────────────────────────────

  /** Canonical conversation key for two user IDs (order-independent). */
  _convKey(id1, id2) {
    return id1 < id2 ? `${id1}:${id2}` : `${id2}:${id1}`;
  }

  /** Insert a message ID into the sorted conversation index (descending by ts). */
  _insertIntoConvIndex(convKey, msgId, ts) {
    if (!this.messagesByConversation.has(convKey)) {
      this.messagesByConversation.set(convKey, []);
    }
    const arr = this.messagesByConversation.get(convKey);
    // Binary insert (descending by timestamp)
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = this.messages.get(arr[mid]);
      if (midMsg && midMsg._ts > ts) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, msgId);
  }

  /** Track a peer relationship for both users. */
  _trackPeers(userId1, userId2) {
    if (!this.peersByUser.has(userId1)) this.peersByUser.set(userId1, new Set());
    if (!this.peersByUser.has(userId2)) this.peersByUser.set(userId2, new Set());
    this.peersByUser.get(userId1).add(userId2);
    this.peersByUser.get(userId2).add(userId1);
  }

  // ─── Users ────────────────────────────────────────────────

  createUser({ username, passwordHash, identityKey, signedPrekey, prekeySig, salt }) {
    const id = uuidv4();
    const user = {
      id,
      username,
      password_hash: passwordHash,
      identity_key: identityKey,
      signed_prekey: signedPrekey,
      prekey_sig: prekeySig,
      salt: salt,
      created_at: new Date().toISOString(),
    };
    this.users.set(id, user);
    this.usernameIndex.set(username.toLowerCase(), id);
    return { ...user };
  }

  updateUserKeys(id, { identityKey, signedPrekey, prekeySig }) {
    const user = this.users.get(id);
    if (!user) return null;
    user.identity_key = identityKey;
    user.signed_prekey = signedPrekey;
    user.prekey_sig = prekeySig;
    return { ...user };
  }

  updateSignedPrekey(id, signedPrekey, prekeySig) {
    const user = this.users.get(id);
    if (!user) return null;
    user.signed_prekey = signedPrekey;
    user.prekey_sig = prekeySig;
    return { ...user };
  }

  setEncryptedVault(id, encryptedVault) {
    const user = this.users.get(id);
    if (!user) return null;
    user.encrypted_vault = encryptedVault;
    return { ...user };
  }

  resetPrekeys(userId, publicKeys) {
    const userPrekeys = this.prekeysByUser.get(userId);
    if (userPrekeys) {
      for (const pkId of userPrekeys) {
        this.prekeys.delete(pkId);
      }
    }
    this.prekeysByUser.set(userId, []);
    return this.uploadPrekeys(userId, publicKeys);
  }

  getDummySalt(username) {
    const hash = crypto.createHash('sha256').update(username.toLowerCase() + '-salt-key').digest();
    return hash.toString('base64').substring(0, 22);
  }

  getUserByUsername(username) {
    const id = this.usernameIndex.get(username.toLowerCase());
    if (!id) return null;
    return { ...this.users.get(id) };
  }

  getUserById(id) {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  // ─── One-Time Prekeys ────────────────────────────────────

  uploadPrekeys(userId, publicKeys) {
    const created = [];
    if (!this.prekeysByUser.has(userId)) {
      this.prekeysByUser.set(userId, []);
    }
    const userPrekeys = this.prekeysByUser.get(userId);

    for (const pk of publicKeys) {
      const id = uuidv4();
      const prekey = {
        id,
        user_id: userId,
        public_key: pk,
        used: false,
        uploaded_at: new Date().toISOString(),
      };
      this.prekeys.set(id, prekey);
      userPrekeys.push(id);
      created.push(prekey);
    }
    return created;
  }

  consumePrekey(userId) {
    const userPrekeys = this.prekeysByUser.get(userId);
    if (!userPrekeys || userPrekeys.length === 0) return null;

    for (let i = 0; i < userPrekeys.length; i++) {
      const pkId = userPrekeys[i];
      const pk = this.prekeys.get(pkId);
      if (pk && !pk.used) {
        pk.used = true;
        // Delete prekey from internal store map to prevent memory leak
        this.prekeys.delete(pkId);
        // Remove from user index array
        userPrekeys.splice(i, 1);
        return { ...pk };
      }
    }
    return null;
  }

  countUnusedPrekeys(userId) {
    const userPrekeys = this.prekeysByUser.get(userId);
    if (!userPrekeys) return 0;

    let count = 0;
    for (const pkId of userPrekeys) {
      const pk = this.prekeys.get(pkId);
      if (pk && !pk.used) count++;
    }
    return count;
  }

  // ─── Key Bundle ──────────────────────────────────────────

  getKeyBundle(username) {
    const user = this.getUserByUsername(username);
    if (!user) return null;

    const oneTimePrekey = this.consumePrekey(user.id);

    return {
      identityKey: user.identity_key,
      signedPrekey: user.signed_prekey,
      prekeySig: user.prekey_sig,
      oneTimePrekey: oneTimePrekey ? oneTimePrekey.public_key : null,
      oneTimePrekeyId: oneTimePrekey ? oneTimePrekey.id : null,
    };
  }

  // ─── Encrypted Messages ──────────────────────────────────

  createMessage({ senderId, recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, expiresAt, iv, groupId = null, attachmentId = null }) {
    const id = uuidv4();
    const now = Date.now();
    const msg = {
      id,
      sender_id: senderId,
      recipient_id: recipientId,
      ciphertext,
      ephemeral_key: ephemeralKey,
      message_number: messageNumber,
      previous_chain: previousChain || 0,
      sent_at: new Date(now).toISOString(),
      _ts: now,  // Numeric timestamp for fast sorting
      expires_at: expiresAt,
      _expires_ts: new Date(expiresAt).getTime(),
      delivered: false,
      iv,
      group_id: groupId
    };
    this.messages.set(id, msg);

    // Update secondary indexes
    const convKey = this._convKey(senderId, recipientId);
    this._insertIntoConvIndex(convKey, id, now);
    this._trackPeers(senderId, recipientId);

    // Track attachment mapping and authorize recipient
    if (attachmentId) {
      if (!this.mediaByMessage.has(id)) {
        this.mediaByMessage.set(id, new Set());
      }
      this.mediaByMessage.get(id).add(attachmentId);

      const mediaItem = this.media.get(attachmentId);
      if (mediaItem) {
        if (!mediaItem.allowed_users) {
          mediaItem.allowed_users = new Set([mediaItem.owner_id || senderId]);
        }
        mediaItem.allowed_users.add(recipientId);
      }
    }

    // Track as undelivered
    if (!this.undeliveredByRecipient.has(recipientId)) {
      this.undeliveredByRecipient.set(recipientId, new Set());
    }
    this.undeliveredByRecipient.get(recipientId).add(id);

    return { ...msg };
  }

  markDelivered(messageId) {
    const msg = this.messages.get(messageId);
    if (msg && !msg.delivered) {
      msg.delivered = true;
      // Remove from undelivered index
      const undelivered = this.undeliveredByRecipient.get(msg.recipient_id);
      if (undelivered) undelivered.delete(messageId);
    }
  }

  getUndeliveredMessages(recipientId) {
    const undelivered = this.undeliveredByRecipient.get(recipientId);
    if (!undelivered || undelivered.size === 0) return [];

    const results = [];
    for (const msgId of undelivered) {
      const msg = this.messages.get(msgId);
      if (msg) results.push({ ...msg });
    }
    // Sort ascending by numeric timestamp (no Date allocation)
    return results.sort((a, b) => a._ts - b._ts);
  }

  getConversationMessages(userId1, userId2, limit = 50, before = null) {
    const convKey = this._convKey(userId1, userId2);
    const msgIds = this.messagesByConversation.get(convKey);
    if (!msgIds || msgIds.length === 0) return [];

    const beforeTs = before ? new Date(before).getTime() : Infinity;
    const results = [];

    // msgIds are sorted descending by timestamp — iterate and collect
    for (const msgId of msgIds) {
      if (results.length >= limit) break;
      const msg = this.messages.get(msgId);
      if (!msg) continue;
      if (msg._ts >= beforeTs) continue;
      results.push({ ...msg });
    }
    return results;
  }

  getConversationsForUser(userId) {
    const peers = this.peersByUser.get(userId);
    if (!peers || peers.size === 0) return [];

    const conversations = [];
    for (const peerId of peers) {
      const peer = this.getUserById(peerId);
      if (!peer) continue;

      // Get the latest message from the conversation index (first element = most recent)
      const convKey = this._convKey(userId, peerId);
      const msgIds = this.messagesByConversation.get(convKey);
      let latest = null;
      if (msgIds && msgIds.length > 0) {
        latest = this.messages.get(msgIds[0]);
      }

      conversations.push({
        peerId,
        peerUsername: peer.username,
        lastMessageAt: latest?.sent_at,
        _lastTs: latest?._ts || 0,
        hasUndelivered: latest && !latest.delivered && latest.recipient_id === userId,
      });
    }

    // Sort by numeric timestamp (no Date allocation)
    return conversations.sort((a, b) => b._lastTs - a._lastTs);
  }

  // ─── Pending Delivery Queue (Redis analog) ───────────────

  enqueuePending(recipientId, messageId) {
    if (!this.pendingQueues.has(recipientId)) {
      this.pendingQueues.set(recipientId, []);
    }
    this.pendingQueues.get(recipientId).push({
      score: Date.now(),
      messageId,
    });
  }

  dequeuePending(recipientId) {
    const queue = this.pendingQueues.get(recipientId);
    if (!queue || queue.length === 0) return [];
    const items = [...queue];
    this.pendingQueues.set(recipientId, []);
    return items.map(i => i.messageId);
  }

  removePending(recipientId, messageId) {
    const queue = this.pendingQueues.get(recipientId);
    if (!queue) return;
    const idx = queue.findIndex(i => i.messageId === messageId);
    if (idx !== -1) queue.splice(idx, 1);
  }

  // ─── WebSocket Registry (Redis analog) ───────────────────

  registerConnection(userId, socket) {
    if (!this.wsConnections.has(userId)) {
      this.wsConnections.set(userId, new Set());
    }
    this.wsConnections.get(userId).add(socket);
  }

  unregisterConnection(userId, socket) {
    const conns = this.wsConnections.get(userId);
    if (conns) {
      conns.delete(socket);
      if (conns.size === 0) this.wsConnections.delete(userId);
    }
  }

  getConnections(userId) {
    return this.wsConnections.get(userId) || new Set();
  }

  isOnline(userId) {
    const conns = this.wsConnections.get(userId);
    return conns && conns.size > 0;
  }

  // ─── Reaper — 24h Hard Deletion ──────────────────────────

  reap() {
    const now = Date.now();
    let reaped = 0;

    // Collect expired message IDs first (avoid delete-while-iterate issues)
    const expiredMsgIds = [];
    for (const [id, msg] of this.messages) {
      if (msg._expires_ts <= now) {
        expiredMsgIds.push(id);
      }
    }

    // Batch delete expired messages and their associated media
    for (const id of expiredMsgIds) {
      const msg = this.messages.get(id);
      if (!msg) continue;

      // Remove from pending queues
      this.removePending(msg.recipient_id, id);

      // Remove associated media using the index (O(k) not O(all_media))
      const mediaIds = this.mediaByMessage.get(id);
      if (mediaIds) {
        for (const mediaId of mediaIds) {
          this.media.delete(mediaId);
        }
        this.mediaByMessage.delete(id);
        reaped += mediaIds.size;
      }

      // Remove from conversation index
      const convKey = this._convKey(msg.sender_id, msg.recipient_id);
      const convMsgs = this.messagesByConversation.get(convKey);
      if (convMsgs) {
        const idx = convMsgs.indexOf(id);
        if (idx !== -1) convMsgs.splice(idx, 1);
        if (convMsgs.length === 0) this.messagesByConversation.delete(convKey);
      }

      // Remove from undelivered index
      if (!msg.delivered) {
        const undelivered = this.undeliveredByRecipient.get(msg.recipient_id);
        if (undelivered) undelivered.delete(id);
      }

      // True delete (not soft-delete)
      this.messages.delete(id);
      reaped++;
    }

    // Also reap orphan media (collect first, then delete)
    const expiredMediaIds = [];
    for (const [mediaId, media] of this.media) {
      if (new Date(media.expires_at).getTime() <= now) {
        expiredMediaIds.push(mediaId);
      }
    }
    for (const mediaId of expiredMediaIds) {
      this.media.delete(mediaId);
      reaped++;
    }

    // Reap expired sessions (older than 24h created OR 2h inactive)
    const sessionExpiryTime = 24 * 60 * 60 * 1000;
    const inactiveExpiryTime = 2 * 60 * 60 * 1000; // 2 hours
    const expiredSessionKeys = [];
    for (const [jwtId, session] of this.sessions) {
      const expired = now - session.createdAt > sessionExpiryTime;
      const inactive = now - (session.lastSeen || session.createdAt) > inactiveExpiryTime;
      if (expired || inactive) {
        expiredSessionKeys.push(jwtId);
      }
    }
    for (const jwtId of expiredSessionKeys) {
      this.sessions.delete(jwtId);
    }

    return reaped;
  }

  // ─── Sessions (Redis analog) ─────────────────────────────

  createSession(jwtId, userId) {
    this.sessions.set(jwtId, {
      userId,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  getSession(jwtId) {
    return this.sessions.get(jwtId) || null;
  }

  deleteSession(jwtId) {
    this.sessions.delete(jwtId);
  }

  touchSession(jwtId) {
    const session = this.sessions.get(jwtId);
    if (session) session.lastSeen = Date.now();
  }

  // ─── Search users ────────────────────────────────────────

  searchUsers(query, excludeUserId) {
    const results = [];
    const q = query.toLowerCase();
    for (const user of this.users.values()) {
      if (user.id === excludeUserId) continue;
      if (user.username.toLowerCase().includes(q)) {
        results.push({
          id: user.id,
          username: user.username,
        });
      }
      if (results.length >= 20) break;
    }
    return results;
  }

  saveAttachment(filename, mimeType, ciphertext, burnOnRead = false, ownerId = null) {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.media.set(id, {
      id,
      filename,
      mimeType,
      ciphertext,
      expires_at: expiresAt,
      burn_on_read: burnOnRead,
      owner_id: ownerId,
      allowed_users: new Set(ownerId ? [ownerId] : [])
    });
    return id;
  }

  getAttachment(id) {
    return this.media.get(id);
  }

  getMessage(id) {
    return this.messages.get(id);
  }

  createGroup(name, memberIds) {
    const id = uuidv4();
    const members = memberIds.map(mId => {
      const u = this.getUserById(mId);
      return { id: mId, username: u ? u.username : 'Unknown' };
    });
    this.groups.set(id, { id, name, members });
    return { id, name, members };
  }

  getGroup(id) {
    return this.groups.get(id);
  }

  getGroupsForUser(userId) {
    const list = [];
    for (const group of this.groups.values()) {
      if (group.members.some(m => m.id === userId)) {
        list.push(group);
      }
    }
    return list;
  }

  registerCall(userId, peerId) {
    this.activeCalls.set(userId, peerId);
    this.activeCalls.set(peerId, userId);
  }

  unregisterCall(userId) {
    const peerId = this.activeCalls.get(userId);
    this.activeCalls.delete(userId);
    if (peerId) {
      this.activeCalls.delete(peerId);
    }
  }

  getActiveCall(userId) {
    return this.activeCalls.get(userId);
  }
}

// Singleton instance
const store = new InMemoryStore();
export default store;
