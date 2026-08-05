// ============================================================
// Vault — WebSocket Client
// Real-time message relay with auto-reconnect
// ============================================================

import { writable, get } from 'svelte/store';
import { updateMessageStatus } from '../stores/messages.js';

export const wsConnected = writable(false);
export const wsError = writable(null);

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Message handlers registered by components
const handlers = new Map();

/**
 * Register a handler for a WebSocket event type.
 */
export function onWsEvent(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
  return () => handlers.get(type)?.delete(handler); // Unsubscribe
}

/**
 * Connect to the WebSocket server.
 * Auth happens via HTTP-only cookie during the upgrade request.
 */
export function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    wsError.set(err.message);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    wsError.set(null);
    reconnectAttempts = 0;
    // Cookie-based auth: server authenticates on HTTP upgrade, no message needed
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'auth_ok') {
        wsConnected.set(true);
        dispatch('connected', data);
        return;
      }

      if (data.type === 'error') {
        wsError.set(data.message);
        if (
          data.message === 'Auth timeout' ||
          data.message === 'Not authenticated' ||
          data.message === 'Session expired' ||
          data.message === 'Invalid token'
        ) {
          import('../stores/session.js').then(({ clearSession }) => {
            clearSession();
          });
        }
        return;
      }

      if (data.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (data.type === 'message' && data.data && data.data.id) {
        wsSend({ type: 'delivered', messageId: data.data.id });
      }

      if (data.type === 'delivered') {
        updateMessageStatus(data.recipientId, data.messageId, 'delivered');
        return;
      }

      if (data.type === 'read') {
        updateMessageStatus(data.recipientId, data.messageId, 'read');
        return;
      }

      // Watermark form: everything up to maxSeq in this chat has been read.
      // One event per chat open instead of one per message, and it also
      // reaches the reader's own other devices so their badge clears too.
      if (data.type === 'read_history') {
        markChatReadUpTo(data.chatId, data.userId, data.maxSeq);
        return;
      }

      // Dispatch to registered handlers
      dispatch(data.type, data.data || data);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  socket.onclose = () => {
    wsConnected.set(false);
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    wsError.set('Connection error');
  };
}

function dispatch(type, data) {
  const typeHandlers = handlers.get(type);
  if (typeHandlers) {
    for (const handler of typeHandlers) {
      try { handler(data); } catch (err) { console.error('[WS] Handler error:', err); }
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connectWebSocket(), delay);
}

/**
 * Send a message via WebSocket.
 */
// Applies a read watermark: marks the caller's own sent messages as read up
// to `maxSeq`, and clears the unread badge when the reader is us.
function markChatReadUpTo(chatId, readerId, maxSeq) {
  Promise.all([
    import('../stores/messages.js'),
    import('../stores/session.js'),
  ]).then(([{ messagesByPeer, conversations }, { currentUser }]) => {
    const me = get(currentUser)?.id;
    messagesByPeer.update((map) => {
      for (const [peerId, messages] of map.entries()) {
        let touched = false;
        for (const m of messages) {
          if (m.chatId !== chatId) continue;
          if (m.senderId === readerId) continue;   // the reader's own messages
          if ((m.seq ?? 0) > maxSeq) continue;
          if (m.status === 'read') continue;
          m.status = 'read';
          m.read = true;
          touched = true;
        }
        if (touched) map.set(peerId, [...messages]);
      }
      return new Map(map);
    });

    // The server broadcasts this to every member, so the badge must only
    // clear when *we* are the reader. Without this check, a peer opening the
    // conversation would silently clear our own unread count.
    if (readerId === me) {
      conversations.update((cs) => {
        const conv = cs.find((c) => c.chatId === chatId);
        if (conv) {
          conv.unreadCount = 0;
          conv.hasUndelivered = false;
        }
        return [...cs];
      });
    }
  }).catch((err) => console.error('[WS] read_history handling failed:', err));
}

export function wsSend(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/**
 * Send typing indicator.
 */
export function sendTyping(recipientId) {
  wsSend({ type: 'typing', recipientId });
}

/**
 * Disconnect WebSocket.
 */
export function disconnectWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  wsConnected.set(false);
  reconnectAttempts = 0;
}

// Reconnect instantly when browser network goes back online
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
      reconnectAttempts = 0;
      connectWebSocket();
    }
  });
}
