// ============================================================
// Vault — repos/config.repo.js
// ============================================================
// Server-wide configuration that must survive restarts (currently the VAPID
// keypair), stored as key/value rows.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.



export function createConfig({ pool }) {
  return {
    pool,

  // Generates a pair of related config values (e.g. VAPID public/private
  // keys) exactly once and persists both together, atomically — avoids
  // ever ending up with a mismatched public/private pair across restarts
  // or a race between concurrent processes.
  async getOrSetConfigPair(publicKeyName, privateKeyName, generatePairFn) {
    const existing = await this.pool.query(
      `SELECT key, value FROM server_config WHERE key IN ($1, $2)`,
      [publicKeyName, privateKeyName]
    );
    if (existing.rows.length === 2) {
      const byKey = Object.fromEntries(existing.rows.map(r => [r.key, r.value]));
      return { publicValue: byKey[publicKeyName], privateValue: byKey[privateKeyName] };
    }

    const { publicValue, privateValue } = await generatePairFn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO server_config (key, value) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [publicKeyName, publicValue, privateKeyName, privateValue]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const final = await this.pool.query(
      `SELECT key, value FROM server_config WHERE key IN ($1, $2)`,
      [publicKeyName, privateKeyName]
    );
    const byKey = Object.fromEntries(final.rows.map(r => [r.key, r.value]));
    return { publicValue: byKey[publicKeyName], privateValue: byKey[privateKeyName] };
  },
  };
}
