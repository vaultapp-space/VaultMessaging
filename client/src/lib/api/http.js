// ============================================================
// Vault — HTTP API Client
// Communicates with Fastify backend via REST
// ============================================================

const API_BASE = '/api';

async function request(method, path, body = null) {
  const options = {
    method,
    headers: {},
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

export async function login(username, password) {
  return request('POST', '/auth/login', { username, password });
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

export async function joinGroup(joinKey) {
  return request('POST', '/groups/join', { joinKey });
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
