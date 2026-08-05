// ============================================================
// Vault — repos/push.repo.js
// ============================================================
// Web Push subscriptions, one row per (user, endpoint).
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createPush({ pool }) {
  return {
    pool,

  async addPushSubscription(userId, subscription) {
    await this.pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, subscription]
    );
  },

  async getPushSubscriptions(userId) {
    const res = await this.pool.query(
      `SELECT subscription FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );
    return new Set(res.rows.map(r => r.subscription));
  },
  };
}
