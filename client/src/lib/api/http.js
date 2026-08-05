// ============================================================
// Vault — HTTP API Client
// Communicates with Fastify backend via REST
// ============================================================

const API_BASE = '/api';

async function request(method, path, body = null, extraHeaders = {}) {
  const options = {
    method,
    headers: { ...extraHeaders },
    credentials: 'include', // Send HTTP-only cookies
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, options);

  if (!res.ok) {
    if (res.status === 401) {
      import('../stores/session.js').then(({ clearSession }) => {
        clearSession();
      });
      throw new Error('Session expired. Please log in again.');
    }
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || error.message || `HTTP ${res.status}`);
  }

  return res.json();
}

// ─── Auth ───────────────────────────────────────────────────

export async function register(data) {
  return request('POST', '/auth/register', data);
}

export async function login(username, password, device = {}) {
  return request('POST', '/auth/login', { username, password, ...device });
}

// ─── Voice chats, topics, stories, contacts ─────────────────

export async function startVoiceChat(chatId, title = null) {
  return request('POST', `/chats/${chatId}/voice`, { title });
}

export async function fetchVoiceChat(chatId) {
  return request('GET', `/chats/${chatId}/voice`);
}

export async function joinVoiceChat(voiceChatId) {
  return request('POST', `/voice/${voiceChatId}/join`);
}

export async function leaveVoiceChat(voiceChatId) {
  return request('POST', `/voice/${voiceChatId}/leave`);
}

export async function setVoiceMute(voiceChatId, muted, userId = null) {
  return request('PATCH', `/voice/${voiceChatId}/mute`, { muted, userId });
}

export async function setForum(chatId, isForum) {
  return request('PATCH', `/chats/${chatId}/forum`, { isForum });
}

export async function fetchTopics(chatId) {
  return request('GET', `/chats/${chatId}/topics`);
}

export async function createTopic(chatId, payload) {
  return request('POST', `/chats/${chatId}/topics`, payload);
}

export async function updateTopic(chatId, topicId, patch) {
  return request('PATCH', `/chats/${chatId}/topics/${topicId}`, patch);
}

export async function postStory(payload) {
  return request('POST', '/stories', payload);
}

export async function fetchStories() {
  return request('GET', '/stories');
}

export async function markStoryViewed(storyId) {
  return request('POST', `/stories/${storyId}/view`);
}

export async function fetchStoryViewers(storyId) {
  return request('GET', `/stories/${storyId}/viewers`);
}

export async function deleteStory(storyId) {
  return request('DELETE', `/stories/${storyId}`);
}

export async function fetchContacts() {
  return request('GET', '/contacts');
}

export async function addContact(userId) {
  return request('POST', `/contacts/${userId}`, {});
}

export async function removeContact(userId) {
  return request('DELETE', `/contacts/${userId}`);
}

// ─── Stickers ───────────────────────────────────────────────

// Everything the picker needs in one call — three separate requests would
// show its sections popping in one at a time.
export async function fetchStickers() {
  return request('GET', '/stickers');
}

// Public media: sticker images and story photos. Not E2EE attachments — they
// are shown to an audience rather than encrypted to a recipient — so they are
// addressed by URL rather than fetched and decrypted.
export function publicMediaUrl(fileId) {
  return `/api/media/${fileId}`;
}

export async function uploadPublicMedia(mimeType, base64) {
  return request('POST', '/media/upload', { mimeType, data: base64 });
}

export async function createStickerSet(payload) {
  return request('POST', '/stickers/sets', payload);
}

export async function addStickerToSet(setId, payload) {
  return request('POST', `/stickers/sets/${setId}/stickers`, payload);
}

export async function fetchStickerSet(shortName) {
  return request('GET', `/stickers/sets/${encodeURIComponent(shortName)}`);
}

export async function searchStickerSets(q) {
  return request('GET', `/stickers/search?q=${encodeURIComponent(q)}`);
}

export async function installStickerSet(setId) {
  return request('POST', `/stickers/sets/${setId}/install`);
}

export async function uninstallStickerSet(setId) {
  return request('DELETE', `/stickers/sets/${setId}/install`);
}

export async function favoriteSticker(stickerId) {
  return request('POST', `/stickers/${stickerId}/favorite`);
}

export async function unfavoriteSticker(stickerId) {
  return request('DELETE', `/stickers/${stickerId}/favorite`);
}

// Called by the client after sending, never inferred server-side: inferring
// it would mean the server watching sticker sends, which in a secret chat it
// cannot and must not do.
export async function markStickerUsed(stickerId) {
  return request('POST', `/stickers/${stickerId}/use`);
}

export async function suggestStickers(emoji) {
  return request('GET', `/stickers/suggest?emoji=${encodeURIComponent(emoji)}`);
}

// ─── Channels ───────────────────────────────────────────────

export async function createChannel(payload) {
  return request('POST', '/channels', payload);
}

export async function fetchChannels() {
  return request('GET', '/channels');
}

export async function searchChannels(q) {
  return request('GET', `/channels/search?q=${encodeURIComponent(q)}`);
}

export async function fetchChannel(chatId) {
  return request('GET', `/channels/${chatId}`);
}

export async function subscribeChannel(chatId) {
  return request('POST', `/channels/${chatId}/subscribe`);
}

export async function unsubscribeChannel(chatId) {
  return request('DELETE', `/channels/${chatId}/subscribe`);
}

export async function fetchChannelPosts(chatId, { limit = 50, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  return request('GET', `/channels/${chatId}/posts?${params}`);
}

export async function postToChannel(chatId, payload) {
  return request('POST', `/channels/${chatId}/posts`, payload);
}

export async function markPostViewed(chatId, seq) {
  return request('POST', `/channels/${chatId}/posts/${seq}/view`);
}

export async function fetchPostComments(chatId, seq) {
  return request('GET', `/channels/${chatId}/posts/${seq}/comments`);
}

export async function commentOnPost(chatId, seq, body) {
  return request('POST', `/channels/${chatId}/posts/${seq}/comments`, { body });
}

export async function updateChannelSettings(chatId, patch) {
  return request('PATCH', `/channels/${chatId}/settings`, patch);
}

export async function fetchChannelAdminLog(chatId) {
  return request('GET', `/channels/${chatId}/admin-log`);
}

// ─── Devices and sync ───────────────────────────────────────

export async function fetchDevices() {
  return request('GET', '/devices');
}

export async function revokeDevice(deviceId) {
  return request('DELETE', `/devices/${deviceId}`);
}

// Everything this account missed since `pts`. A `tooLong: true` reply is not
// an error — it means the gap is bigger than the log can serve, and the
// caller should refetch rather than try to patch up local state.
export async function fetchUpdates(pts = 0) {
  return request('GET', `/updates?pts=${pts}`);
}

export async function logout() {
  return request('POST', '/auth/logout');
}

export async function getMe() {
  return request('GET', '/auth/me');
}

export async function fetchSalt(username) {
  return request('GET', `/auth/salt/${encodeURIComponent(username)}`);
}

// ─── Key Bundles ────────────────────────────────────────────

export async function fetchKeyBundle(username) {
  return request('GET', `/keys/bundle/${encodeURIComponent(username)}`);
}

export async function replenishPrekeys(prekeys) {
  return request('POST', '/keys/replenish', { prekeys });
}

export async function getPrekeyCount() {
  return request('GET', '/keys/count');
}

export async function updateKeys(data) {
  return request('PUT', '/keys/update', data);
}

// ─── Messages ───────────────────────────────────────────────

export async function sendMessage(data) {
  return request('POST', '/messages', data);
}

export async function fetchMessages(peerId, limit = 50, before = null) {
  let url = `/messages/${peerId}?limit=${limit}`;
  if (before) url += `&before=${encodeURIComponent(before)}`;
  return request('GET', url);
}

export async function fetchPendingMessages() {
  return request('GET', '/messages/pending/all');
}

export async function fetchConversations() {
  return request('GET', '/conversations');
}

// ─── Users ──────────────────────────────────────────────────

export async function searchUsers(query) {
  return request('GET', `/users/search?q=${encodeURIComponent(query)}`);
}

export async function uploadAttachment(filename, mimeType, ciphertext, burnOnRead = false) {
  return request('POST', '/attachments', { filename, mimeType, ciphertext, burnOnRead });
}

export async function fetchAttachment(id) {
  return request('GET', `/attachments/${id}`);
}

export async function updateSignedPrekey(signedPrekey, prekeySig) {
  return request('PUT', '/keys/signed-prekey', { signedPrekey, prekeySig });
}

export async function createGroup(name, members) {
  return request('POST', '/groups', { name, members });
}

export async function fetchGroups() {
  return request('GET', '/groups');
}

export async function initChunkedUpload(filename, mimeType, totalChunks, burnOnRead = false) {
  return request('POST', '/attachments/chunk/init', { filename, mimeType, totalChunks, burnOnRead });
}

export async function uploadAttachmentChunk(id, index, ciphertext) {
  return request('POST', `/attachments/chunk/upload/${id}/${index}`, { ciphertext });
}

export async function fetchAttachmentChunk(id, index) {
  return request('GET', `/attachments/chunk/download/${id}/${index}`);
}

export async function saveEncryptedVault(encryptedVault) {
  return request('POST', '/auth/vault', { encryptedVault });
}

// joinGroup() lived here. It posted a permanent bearer secret; invite links
// replaced it and migration 0016 dropped the column. Joining is now
// joinByInvite(), redeemed by App.svelte when an invite link is opened.

export async function leaveGroup(groupId) {
  return request('POST', `/groups/${groupId}/leave`);
}

export async function removeGroupMember(groupId, userId) {
  return request('DELETE', `/groups/${groupId}/members/${userId}`);
}

export async function fetchTurnCredentials() {
  return request('GET', '/turn/credentials');
}

export async function sendClientDebugLog(message, error, context = {}) {
  try {
    await fetch(`${API_BASE}/debug/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, error: error?.stack || error?.message || String(error), context })
    });
  } catch (e) {
    console.error('Failed to send client debug log to server:', e);
  }
}

// ─── Chats (cloud mode) ─────────────────────────────────────
// The chat model introduced in Phase 1. These sit alongside the existing
// message endpoints rather than replacing them: a secret chat still sends
// ciphertext through sendMessage() above, and both write the same row.

export async function fetchChats({ archived = false } = {}) {
  return request('GET', `/chats?archived=${archived ? 'true' : 'false'}`);
}

export async function fetchChat(chatId) {
  return request('GET', `/chats/${chatId}`);
}

export async function openPrivateChat(peerId, mode = 'cloud') {
  return request('POST', '/chats/private', { peerId, mode });
}

export async function sendCloudMessage(chatId, payload) {
  return request('POST', `/chats/${chatId}/messages`, payload);
}

export async function fetchChatMessages(chatId, { limit = 50, before = null, topicId = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', String(before));
  // Omitted for non-forum chats, which is what returns the whole
  // conversation rather than an empty topic.
  if (topicId) params.set('topicId', String(topicId));
  return request('GET', `/chats/${chatId}/messages?${params}`);
}

export async function markChatRead(chatId, maxSeq) {
  return request('POST', `/chats/${chatId}/read`, { maxSeq });
}

// ─── Reactions (cloud mode) ─────────────────────────────────
// Secret chats never call these: their reactions travel as encrypted t:'op'
// envelopes through the ordinary message path.

export async function addReaction(chatId, seq, emoji) {
  return request('POST', `/chats/${chatId}/messages/${seq}/reactions`, { emoji });
}

export async function removeReaction(chatId, seq, emoji) {
  return request('DELETE', `/chats/${chatId}/messages/${seq}/reactions/${encodeURIComponent(emoji)}`);
}

export async function editCloudMessage(chatId, seq, body, entities = null) {
  return request('PATCH', `/chats/${chatId}/messages/${seq}`, { body, entities });
}

// ─── Phase 2 ────────────────────────────────────────────────

export async function deleteMessage(chatId, seq, forEveryone = false) {
  return request('DELETE', `/chats/${chatId}/messages/${seq}?forEveryone=${forEveryone}`);
}

export async function pinMessage(chatId, seq) {
  return request('POST', `/chats/${chatId}/messages/${seq}/pin`);
}

export async function unpinMessage(chatId, seq) {
  return request('DELETE', `/chats/${chatId}/messages/${seq}/pin`);
}

export async function fetchPinned(chatId) {
  return request('GET', `/chats/${chatId}/pinned`);
}

export async function forwardMessages(fromChatId, toChatId, seqs) {
  return request('POST', `/chats/${fromChatId}/forward`, { toChatId, seqs });
}

export async function saveDraft(chatId, body, replyToSeq = null) {
  return request('PUT', `/chats/${chatId}/draft`, { body, replyToSeq });
}

export async function fetchDrafts() {
  return request('GET', '/drafts');
}

export async function updateChatSettings(chatId, patch) {
  return request('PATCH', `/chats/${chatId}/settings`, patch);
}

// Marks a message opened. For a view-once message this is what actually
// destroys it: the server clears the content, so hiding it client-side alone
// would be defeated by opening the network tab.
export async function markMessageViewed(chatId, seq) {
  return request('POST', `/chats/${chatId}/messages/${seq}/view`);
}

export async function blockUser(userId) {
  return request('POST', `/users/${userId}/block`);
}

export async function unblockUser(userId) {
  return request('DELETE', `/users/${userId}/block`);
}

export async function fetchBlocked() {
  return request('GET', '/blocks');
}

export async function fetchPresence(userIds) {
  return request('GET', `/presence?userIds=${userIds.join(',')}`);
}

export async function searchMessages(query, limit = 50) {
  return request('GET', `/search/messages?q=${encodeURIComponent(query)}&limit=${limit}`);
}

// ─── Phase 3 ────────────────────────────────────────────────
// Revocable invites replace the old permanent `joinKey`. Prefer these for any
// new join flow; the join-key path remains only for backwards compatibility.

export async function createInvite(chatId, options = {}) {
  return request('POST', `/chats/${chatId}/invites`, options);
}

export async function listInvites(chatId) {
  return request('GET', `/chats/${chatId}/invites`);
}

export async function revokeInvite(chatId, hash) {
  return request('DELETE', `/chats/${chatId}/invites/${encodeURIComponent(hash)}`);
}

export async function joinByInvite(hash) {
  return request('POST', `/invites/${encodeURIComponent(hash)}/join`);
}

export async function fetchRights(chatId) {
  return request('GET', `/chats/${chatId}/rights`);
}

export async function setMemberRole(chatId, userId, role) {
  return request('PATCH', `/chats/${chatId}/members/${userId}/role`, { role });
}

export async function banMember(chatId, userId, until = null) {
  return request('POST', `/chats/${chatId}/members/${userId}/ban`, { until });
}

export async function unbanMember(chatId, userId) {
  return request('DELETE', `/chats/${chatId}/members/${userId}/ban`);
}

export async function createPoll(chatId, poll) {
  return request('POST', `/chats/${chatId}/polls`, poll);
}

export async function votePoll(chatId, seq, optionIds) {
  return request('POST', `/chats/${chatId}/messages/${seq}/vote`, { optionIds });
}

export async function fetchPoll(chatId, seq) {
  return request('GET', `/chats/${chatId}/messages/${seq}/poll`);
}

export async function fetchFolders() {
  return request('GET', '/folders');
}

export async function createFolder(title, emoji = null) {
  return request('POST', '/folders', { title, emoji });
}

export async function setFolderChats(folderId, chatIds) {
  return request('PUT', `/folders/${folderId}/chats`, { chatIds });
}

export async function deleteFolder(folderId) {
  return request('DELETE', `/folders/${folderId}`);
}
