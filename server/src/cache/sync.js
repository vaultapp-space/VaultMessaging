// ============================================================
// Vault — cache/sync.js
// ============================================================
// One-shot QR device-sync relay. Payloads are encrypted client-side and
// deleted on first retrieval.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createSync({ redis }) {
  return {
    redis,

  async createSyncSession(syncId, payload, userId) {
    await this.redis.set(`sync:${syncId}`, JSON.stringify({ payload, userId }), 'EX', 120); // Expires in 2 minutes
  },

  async getSyncSession(syncId) {
    const raw = await this.redis.get(`sync:${syncId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  },

  async deleteSyncSession(syncId) {
    await this.redis.del(`sync:${syncId}`);
  },
  };
}
