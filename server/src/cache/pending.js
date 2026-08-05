// ============================================================
// Vault — cache/pending.js
// ============================================================
// Per-recipient queue of undelivered message ids, flushed on reconnect.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createPending({ redis }) {
  return {
    redis,

  async enqueuePending(recipientId, messageId) {
    await this.redis.sadd(`pending:${recipientId}`, messageId);
  },

  async dequeuePending(recipientId) {
    const messages = await this.redis.smembers(`pending:${recipientId}`);
    await this.redis.del(`pending:${recipientId}`);
    return messages;
  },

  async removePending(recipientId, messageId) {
    await this.redis.srem(`pending:${recipientId}`, messageId);
  },
  };
}
