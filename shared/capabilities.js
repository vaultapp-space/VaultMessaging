// ============================================================
// Vault — Chat Capabilities
// ============================================================
// What a chat can do, decided by its mode. Shared by client and server so the
// two can never disagree: the client uses it to disable controls, the server
// uses it to refuse requests. A capability enforced in only one of those
// places is not enforced.
//
// The split is not arbitrary. Cloud-only features are the ones that require
// the server to *read* message content — it cannot search, unfurl a link, or
// let a bot respond to something it only ever sees as ciphertext. Secret-only
// features are the ones that depend on there being exactly one device holding
// the keys.
//
// Everything else — reactions, replies, edits, deletes, pins, forwards,
// drafts, polls, media — works in both, because the `t:'op'` envelope carries
// the operation either way: an HTTP call in a cloud chat, an encrypted
// message applied client-side in a secret one.

export const ChatMode = Object.freeze({
  CLOUD: 'cloud',
  SECRET: 'secret',
});

// Requires the server to read message content.
const CLOUD_ONLY = Object.freeze([
  'serverSearch',      // global search across chats
  'scheduledSend',     // a worker must dispatch it later
  'linkPreview',       // the server fetches and unfurls the URL
  'bots',              // a bot has to receive the message
  'multiDeviceSync',   // history replayed to a device that has no keys
  'channels',          // broadcast fanout the server must address
  'serverSideForward', // forwarding with attribution intact
]);

// Requires a single device holding the keys, or the ratchet itself.
const SECRET_ONLY = Object.freeze([
  'perMessageTtl',     // the self-destruct slider
  'burnOnRead',        // attachment authorisation revoked per recipient
  'safetyNumbers',     // fingerprint verification of the peer's identity key
]);

// Works in both modes.
const UNIVERSAL = Object.freeze([
  'text', 'media', 'voiceNotes', 'reactions', 'replies', 'edit', 'delete',
  'forward', 'pin', 'drafts', 'polls', 'stickers', 'typing', 'readReceipts',
  'calls', 'localSearch', 'mute', 'archive',
]);

export const Capability = Object.freeze(
  Object.fromEntries([...CLOUD_ONLY, ...SECRET_ONLY, ...UNIVERSAL].map((c) => [c, c]))
);

/**
 * Capabilities for a chat.
 *
 * Accepts a chat object or a bare mode string. An unknown or missing mode is
 * treated as secret — the more restrictive of the two — so a bug can only
 * ever withhold a feature, never leak content to the server.
 */
export function capabilities(chatOrMode) {
  const mode = typeof chatOrMode === 'string' ? chatOrMode : chatOrMode?.mode;
  const isCloud = mode === ChatMode.CLOUD;

  const allowed = new Set([
    ...UNIVERSAL,
    ...(isCloud ? CLOUD_ONLY : SECRET_ONLY),
  ]);

  return {
    mode: isCloud ? ChatMode.CLOUD : ChatMode.SECRET,
    isCloud,
    isSecret: !isCloud,
    has: (capability) => allowed.has(capability),
    list: () => [...allowed].sort(),
  };
}

export function supports(chatOrMode, capability) {
  return capabilities(chatOrMode).has(capability);
}

/**
 * Throws unless the chat supports the capability. Used on the server to
 * reject a request the client should not have made, and on the client to fail
 * loudly in development rather than silently producing a message the peer
 * cannot read.
 */
export function assertSupports(chatOrMode, capability) {
  if (!supports(chatOrMode, capability)) {
    const { mode } = capabilities(chatOrMode);
    throw new Error(`Capability '${capability}' is not available in ${mode} chats`);
  }
}
