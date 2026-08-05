// ============================================================
// Vault — repos/prekeys.repo.js
// ============================================================
// X3DH prekey material: the signed prekey plus the one-time prekey pool
// that gets consumed one entry per new session.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createPrekeys({ pool, users }) {
  return {
    pool,

  async resetPrekeys(userId, publicKeys) {
    await this.pool.query(`DELETE FROM one_time_prekeys WHERE user_id = $1`, [userId]);
    if (publicKeys.length > 0) {
      await this.uploadPrekeys(userId, publicKeys);
    }
  },

  async uploadPrekeys(userId, publicKeys) {
    if (publicKeys.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const pk of publicKeys) {
        await client.query(
          `INSERT INTO one_time_prekeys (user_id, public_key) VALUES ($1, $2)`,
          [userId, pk]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async consumePrekey(userId) {
    const res = await this.pool.query(
      `UPDATE one_time_prekeys SET used = TRUE
       WHERE id = (
         SELECT id FROM one_time_prekeys
         WHERE user_id = $1 AND used = FALSE
         ORDER BY uploaded_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING public_key`,
      [userId]
    );
    return res.rows[0] ? res.rows[0].public_key : null;
  },

  async countUnusedPrekeys(userId) {
    const res = await this.pool.query(
      `SELECT COUNT(*) as count FROM one_time_prekeys
       WHERE user_id = $1 AND used = FALSE`,
      [userId]
    );
    return parseInt(res.rows[0].count, 10);
  },

  async getKeyBundle(username) {
    const user = await users.getUserByUsername(username);
    if (!user) return null;
    const opk = await this.consumePrekey(user.id);
    return {
      identityKey: user.identity_key,
      signedPrekey: user.signed_prekey,
      prekeySig: user.prekey_sig,
      oneTimePrekey: opk
    };
  },
  };
}
