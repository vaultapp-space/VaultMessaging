// ============================================================
// Vault — cache/quota.js
// ============================================================
// Monthly per-user upload quota counters.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createQuota({ redis }) {
  return {
    redis,

  async checkAndIncrementUploadUsage(userId, size) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    const redisKey = `user:upload_limit:${userId}:${yearMonth}`;
    const LIMIT = 50 * 1024 * 1024; // 50MB

    // Atomically reserve the usage first to avoid a check-then-increment race
    // between concurrent uploads, then roll back if it pushed us over the limit.
    const newUsage = await this.redis.incrby(redisKey, size);
    await this.redis.expire(redisKey, 35 * 24 * 60 * 60); // 35 days

    if (newUsage > LIMIT) {
      await this.redis.decrby(redisKey, size);
      throw new Error('Monthly upload limit of 50MB exceeded');
    }
  },

  // Refunds previously-charged upload usage when the chunk was never
  // actually persisted (e.g. a disk write failure after the quota check).
  async refundUploadUsage(userId, size) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    const redisKey = `user:upload_limit:${userId}:${yearMonth}`;
    await this.redis.decrby(redisKey, size);
  },
  };
}
