// ============================================================
// Vault — WebSocket Route
// Real-time message relay + pending queue flush on connect
// Auth via HTTP-only cookie during WebSocket upgrade
// ============================================================

import { WS_EVENTS, WS_HEARTBEAT_INTERVAL_MS, UUID_PATTERN } from '../utils/constants.js';

const UUID_RE = new RegExp(UUID_PATTERN);
import config from '../config.js';

/**
 * Flush pending messages to a WebSocket.
 * Extracted to avoid code duplication between cookie and message auth paths.
 */
async function flushPendingMessages(fastify, userId, socket) {
  const messages = await fastify.store.getUndeliveredMessages(userId);
  if (messages.length === 0) return;

  // Batch user lookups — collect unique sender IDs first
  const senderIds = new Set(messages.map(m => m.sender_id));
  const senderMap = new Map();
  for (const sid of senderIds) {
    const sender = await fastify.store.getUserById(sid);
    senderMap.set(sid, sender?.username || 'unknown');
  }

  for (const msg of messages) {
    let groupName = null;
    let groupMembers = null;
    let groupJoinKey = null;
    if (msg.group_id) {
      const groupObj = await fastify.store.getGroup(msg.group_id);
      if (groupObj) {
        groupName = groupObj.name;
        groupMembers = groupObj.members;
        groupJoinKey = groupObj.joinKey;
      }
    }

    try {
      socket.send(JSON.stringify({
        type: 'message',
        data: {
          id: msg.id,
          senderId: msg.sender_id,
          senderUsername: senderMap.get(msg.sender_id),
          ciphertext: msg.ciphertext,
          ephemeralKey: msg.ephemeral_key,
          iv: msg.iv,
          messageNumber: msg.message_number,
          previousChain: msg.previous_chain,
          sentAt: msg.sent_at,
          expiresAt: msg.expires_at,
          groupId: msg.group_id,
          groupName,
          groupMembers,
          groupJoinKey
        },
      }));
      await fastify.store.markDelivered(msg.id);
      await fastify.store.removePending(userId, msg.id);
    } catch (err) {
      fastify.log.error({ err, userId, messageId: msg.id }, 'Failed to deliver pending message over WebSocket, aborting flush');
      break;
    }
  }
}

/**
 * Start the heartbeat timer for a WebSocket connection.
 */
function startHeartbeat(socket) {
  return setInterval(() => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: WS_EVENTS.HEARTBEAT }));
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
}

async function wsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    // Verify Origin header to prevent Cross-Site WebSocket Hijacking (CSWSH)
    const origin = request.headers.origin;
    const isDev = process.env.NODE_ENV !== 'production';
    const isAllowedOrigin = !origin || origin === config.clientOrigin || 
      origin === 'https://vaultapp.space' || origin === 'https://www.vaultapp.space' ||
      (isDev && (origin.startsWith('http://localhost:') || origin.match(/^http:\/\/\d+\.\d+\.\d+\.\d+:5173$/) || origin.endsWith(':5173')));

    if (origin && !isAllowedOrigin) {
      fastify.log.warn({ origin }, 'WebSocket connection rejected: Origin mismatch');
      socket.close(4003, 'Forbidden Origin');
      return;
    }

    let userId = null;
    let heartbeatTimer = null;
    let authenticated = false;

    // ─── Authenticate via cookie on connection ────────────────
    // The cookie is sent during the WebSocket HTTP upgrade request
    try {
      const cookieValue = request.cookies?.[config.cookieName];
      if (cookieValue) {
        const decoded = fastify.jwt.verify(cookieValue);
        const session = await fastify.store.getSession(decoded.jti);
        if (session) {
          userId = decoded.id;
          authenticated = true;

          // Register WebSocket connection
          fastify.store.registerConnection(userId, socket);

          // Start heartbeat
          heartbeatTimer = startHeartbeat(socket);

          // Flush pending delivery queue
          await flushPendingMessages(fastify, userId, socket);

          socket.send(JSON.stringify({ type: 'auth_ok', userId }));
          fastify.log.info({ userId }, 'WebSocket authenticated via cookie');
        }
      }
    } catch (err) {
      fastify.log.warn({ err }, 'WebSocket cookie auth failed');
    }

    // If cookie auth failed, try message-based auth with timeout
    const authTimeout = !authenticated ? setTimeout(() => {
      if (!authenticated) {
        socket.send(JSON.stringify({ type: 'error', message: 'Auth timeout' }));
        socket.close();
      }
    }, 5000) : null;

    socket.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      try {
        await handleMessage(data);
      } catch (err) {
        // Last-resort safety net: an uncaught error here would otherwise
        // become an unhandled promise rejection and, depending on Node's
        // configuration, can crash the entire process for every connected
        // user — a single malformed message must never do that.
        fastify.log.error({ err, userId, type: data?.type }, 'Unhandled error processing WebSocket message');
        try { socket.send(JSON.stringify({ type: 'error', message: 'Internal error' })); } catch {}
      }
    });

    async function handleMessage(data) {
      // ─── AUTH message (fallback if cookie auth failed) ─────────
      if (data.type === 'auth' && !authenticated) {
        if (authTimeout) clearTimeout(authTimeout);
        try {
          const decoded = fastify.jwt.verify(data.token);
          const session = await fastify.store.getSession(decoded.jti);
          if (!session) {
            socket.send(JSON.stringify({ type: 'error', message: 'Session expired' }));
            socket.close();
            return;
          }

          userId = decoded.id;
          authenticated = true;
          fastify.store.registerConnection(userId, socket);

          heartbeatTimer = startHeartbeat(socket);

          // Flush pending
          await flushPendingMessages(fastify, userId, socket);

          socket.send(JSON.stringify({ type: 'auth_ok', userId }));
          fastify.log.info({ userId }, 'WebSocket authenticated via message');
        } catch (err) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          socket.close();
        }
        return;
      }

      // ─── Reject unauthenticated messages ───────────────────
      if (!authenticated) {
        socket.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // ─── HEARTBEAT ACK ────────────────────────────────────────
      if (data.type === WS_EVENTS.HEARTBEAT_ACK || data.type === 'pong') {
        return;
      }

      // ─── TYPING indicator ─────────────────────────────────────
      if (data.type === WS_EVENTS.TYPING && data.recipientId) {
        const recipientSockets = fastify.store.getConnections(data.recipientId);
        const payload = JSON.stringify({
          type: WS_EVENTS.TYPING,
          senderId: userId,
        });
        for (const s of recipientSockets) {
          try { s.send(payload); } catch {}
        }
        return;
      }

      // ─── WebRTC Signaling Relay ────────────────────────────────
      const callEventTypes = ['call_invite', 'call_accept', 'call_reject', 'call_hangup', 'webrtc_sdp', 'webrtc_ice', 'webrtc_media_state'];
      if (callEventTypes.includes(data.type) && data.recipientId) {
        if (!UUID_RE.test(data.recipientId)) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid call recipient' }));
          return;
        }

        fastify.log.info({ type: data.type, userId, recipientId: data.recipientId }, 'WebRTC signaling event received');

        // Validate recipientId is a real user
        const recipient = await fastify.store.getUserById(data.recipientId);
        if (!recipient) {
          fastify.log.warn({ recipientId: data.recipientId }, 'WebRTC signaling failed: Invalid recipient');
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid call recipient' }));
          return;
        }

        // For SDP/ICE/media state relay, verify an active call session exists between the two parties
        if (data.type === 'webrtc_sdp' || data.type === 'webrtc_ice' || data.type === 'webrtc_media_state') {
          const activePeer = fastify.store.getActiveCall(userId);
          if (!activePeer || activePeer !== data.recipientId) {
            fastify.log.warn({ type: data.type, userId, recipientId: data.recipientId, activePeer }, 'WebRTC signaling check failed: No active call session');
            socket.send(JSON.stringify({ type: 'error', message: 'No active call session' }));
            return;
          }
        }

        if (data.type === 'call_invite') {
          // Record who this invite is FROM so a later call_accept can be
          // verified against it, rather than trusting an arbitrary recipientId.
          fastify.store.setPendingInvite(data.recipientId, userId);
        } else if (data.type === 'call_accept') {
          // Only honor call_accept if it actually corresponds to a pending
          // invite from that recipient — otherwise any authenticated user
          // could send call_accept for an arbitrary recipientId and hijack
          // or overwrite that person's active call mapping.
          const inviter = fastify.store.getPendingInvite(userId);
          if (inviter !== data.recipientId) {
            fastify.log.warn({ userId, recipientId: data.recipientId }, 'WebRTC call_accept rejected: no matching pending invite');
            socket.send(JSON.stringify({ type: 'error', message: 'No pending call invite from this user' }));
            return;
          }
          fastify.store.clearPendingInvite(userId);
          fastify.log.info({ userId, recipientId: data.recipientId }, 'WebRTC call_accept: Registering call mapping');
          fastify.store.registerCall(userId, data.recipientId);
        } else if (data.type === 'call_reject') {
          fastify.store.clearPendingInvitesInvolving(userId);
        } else if (data.type === 'call_hangup') {
          fastify.log.info({ userId }, 'WebRTC call_hangup: Unregistering call mapping');
          fastify.store.unregisterCall(userId);
          fastify.store.clearPendingInvitesInvolving(userId);
        }

        const recipientSockets = fastify.store.getConnections(data.recipientId);
        fastify.log.info({ type: data.type, recipientId: data.recipientId, socketCount: recipientSockets.size }, 'Forwarding WebRTC signaling event');
        const payload = JSON.stringify({
          ...data,
          senderId: userId,
        });
        for (const s of recipientSockets) {
          try { s.send(payload); } catch {}
        }
        return;
      }

      // ─── DELIVERED acknowledgment ──────────────────────────────
      if (data.type === WS_EVENTS.DELIVERED && data.messageId) {
        if (!UUID_RE.test(data.messageId)) return;
        const msg = await fastify.store.getMessage(data.messageId);
        if (msg && msg.recipient_id === userId) {
          await fastify.store.markDelivered(data.messageId);
          const senderSockets = fastify.store.getConnections(msg.sender_id);
          const payload = JSON.stringify({
            type: WS_EVENTS.DELIVERED,
            messageId: data.messageId,
            recipientId: userId
          });
          for (const s of senderSockets) {
            try { s.send(payload); } catch {}
          }
        }
        return;
      }

      // ─── READ acknowledgment ───────────────────────────────────
      if (data.type === 'read' && data.messageId) {
        if (!UUID_RE.test(data.messageId)) return;
        const msg = await fastify.store.getMessage(data.messageId);
        if (msg && msg.recipient_id === userId) {
          await fastify.store.markRead(data.messageId);
          const senderSockets = fastify.store.getConnections(msg.sender_id);
          const payload = JSON.stringify({
            type: 'read',
            messageId: data.messageId,
            recipientId: userId
          });
          for (const s of senderSockets) {
            try { s.send(payload); } catch {}
          }
        }
        return;
      }
    }

    // ─── Cleanup on disconnect ───────────────────────────────
    socket.on('close', () => {
      if (authTimeout) clearTimeout(authTimeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (userId) {
        // Automatic WebRTC Call Cleanup
        const activeCallPeer = fastify.store.getActiveCall(userId);
        if (activeCallPeer) {
          const peerSockets = fastify.store.getConnections(activeCallPeer);
          const payload = JSON.stringify({
            type: 'call_hangup',
            senderId: userId
          });
          for (const s of peerSockets) {
            try { s.send(payload); } catch {}
          }
          fastify.store.unregisterCall(userId);
        }
        fastify.store.clearPendingInvitesInvolving(userId);

        fastify.store.unregisterConnection(userId, socket);
        fastify.log.info({ userId }, 'WebSocket disconnected');
      }
    });

    socket.on('error', (err) => {
      fastify.log.error({ err, userId }, 'WebSocket error');
    });
  });
}

export default wsRoutes;
