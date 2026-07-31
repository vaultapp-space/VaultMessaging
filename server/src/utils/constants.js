// ============================================================
// Vault — Shared Constants
// ============================================================

export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const MAX_TTL_MINUTES = 1440; // 24 hours hard ceiling
export const MAX_USERNAME_LENGTH = 32;
export const MIN_USERNAME_LENGTH = 3;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PREKEYS_PER_UPLOAD = 100;
export const LOW_PREKEY_THRESHOLD = 10;
export const MAX_MESSAGE_SIZE_BYTES = 64 * 1024; // 64 KB ciphertext limit
export const MAX_MEDIA_CHUNK_SIZE = 1 * 1024 * 1024;  // 1 MB per chunk — must match the client's CHUNK_SIZE in ChatView.svelte
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const WS_HEARTBEAT_TIMEOUT_MS = 10_000;

// WebSocket event types
export const WS_EVENTS = {
  MESSAGE: 'message',
  DELIVERED: 'delivered',
  TYPING: 'typing',
  RATCHET_RESET: 'ratchet_reset',
  PREKEY_LOW: 'prekey_low',
  HEARTBEAT: 'ping',
  HEARTBEAT_ACK: 'pong',
  ERROR: 'error',
};
