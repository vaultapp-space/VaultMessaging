// ============================================================
// Vault — repos/devices.repo.js
// ============================================================
// Devices, and the per-user update log they catch up from.
//
// The update log is the part worth reading carefully. Before this, a message
// carried a `delivered` boolean, which quietly assumes one device per account:
// with two, "delivered" has no single answer and the flag starts lying to
// whichever device asks second.
//
// The replacement is Telegram's: a monotonic `pts` per user. Every change
// appends a row, each device records how far it has read, and reconnecting
// means asking for everything past that point. Two consequences fall out:
//
//   - Ordering is total and per-user, so a device can never apply updates in
//     a different order than they happened.
//   - Catching up is a range scan, not a diff of application state, so the
//     server never has to reason about what a given device already knows.
//
// Retention is not an afterthought here. These rows hold message content, so
// they expire on the same 24-hour schedule as messages. A device offline for
// longer is told `tooLong` and refetches — which is the honest answer, since
// there is nothing older than a day left to replay.

const RETENTION_SECONDS = 86400;

export function createDevices({ pool }) {
  return {
    pool,

    // ─── Devices ──────────────────────────────────────────

    /**
     * Registers a device for a user, or refreshes one that already exists.
     *
     * A new device deliberately starts at the user's *current* pts rather
     * than 0: it is about to load the chat list from scratch, so replaying
     * the last day of updates on top would double every message it is
     * already fetching.
     */
    async register(userId, { name = null, platform = null, appVersion = null, ip = null } = {}) {
      const { rows } = await this.pool.query(
        `INSERT INTO devices (user_id, name, platform, app_version, last_ip, pts)
         VALUES ($1, $2, $3, $4, $5, (SELECT pts FROM users WHERE id = $1))
         RETURNING id, user_id, name, platform, app_version, created_at,
                   last_active_at, pts`,
        [userId, name, platform, appVersion, ip]
      );
      return this.shape(rows[0]);
    },

    shape(row) {
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        platform: row.platform,
        appVersion: row.app_version,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        pts: Number(row.pts),
        revokedAt: row.revoked_at ?? null,
      };
    },

    async get(deviceId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM devices WHERE id = $1`, [deviceId]
      );
      return this.shape(rows[0]);
    },

    /** Active devices only — a revoked one is not something to keep showing. */
    async listForUser(userId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM devices
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_active_at DESC`,
        [userId]
      );
      return rows.map((r) => this.shape(r));
    },

    async touch(deviceId, ip = null) {
      await this.pool.query(
        `UPDATE devices SET last_active_at = now(), last_ip = COALESCE($2, last_ip)
          WHERE id = $1`,
        [deviceId, ip]
      );
    },

    /**
     * Revokes a device.
     *
     * Scoped by user_id in the same statement rather than checked first: a
     * separate ownership check is a race, and this is the one operation where
     * getting it wrong means one account signing out another.
     *
     * The row is kept, not deleted — `user_updates` and any in-flight
     * references stay resolvable, and a revoked device is a thing worth being
     * able to see happened.
     */
    async revoke(userId, deviceId) {
      const { rowCount } = await this.pool.query(
        `UPDATE devices SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [deviceId, userId]
      );
      return rowCount > 0;
    },

    async isRevoked(deviceId) {
      const { rows } = await this.pool.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id = $1`,
        [deviceId]
      );
      // An unknown device id is treated as revoked. Anything else would make
      // a deleted account's token keep working.
      return rows.length === 0 || rows[0].revoked;
    },

    async setPts(deviceId, pts) {
      await this.pool.query(
        // Never moves backwards: two connections for the same device can
        // report their positions out of order, and the lower one must not
        // undo the higher one's progress.
        `UPDATE devices SET pts = GREATEST(pts, $2) WHERE id = $1`,
        [deviceId, pts]
      );
    },

    // ─── The update log ───────────────────────────────────

    /**
     * Appends an update for a user and returns its pts.
     *
     * The counter lives on `users` and is bumped in the same statement that
     * reads it, so concurrent appends cannot collide on a pts value.
     */
    async append(userId, kind, payload, { ttlSeconds = RETENTION_SECONDS } = {}) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: ptsRows } = await client.query(
          `UPDATE users SET pts = pts + 1 WHERE id = $1 RETURNING pts`,
          [userId]
        );
        if (ptsRows.length === 0) {
          await client.query('ROLLBACK');
          return null;
        }
        const pts = Number(ptsRows[0].pts);

        await client.query(
          `INSERT INTO user_updates (user_id, pts, kind, payload, expires_at)
           VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
          [userId, pts, kind, JSON.stringify(payload ?? {}),
            String(Math.min(ttlSeconds, RETENTION_SECONDS))]
        );

        await client.query('COMMIT');
        return pts;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async currentPts(userId) {
      const { rows } = await this.pool.query(
        `SELECT pts FROM users WHERE id = $1`, [userId]
      );
      return rows.length ? Number(rows[0].pts) : 0;
    },

    /**
     * Everything a device missed.
     *
     * Returns `{ tooLong: true }` when the gap cannot be served — either the
     * client is asking from before the oldest row still kept, or there are
     * more updates than one replay should carry. The client's response to
     * both is the same: throw away local state and refetch the chat list,
     * which is cheap precisely because there is only ever a day of it.
     */
    async since(userId, fromPts, { limit = 500 } = {}) {
      const current = await this.currentPts(userId);
      if (fromPts >= current) return { updates: [], pts: current, tooLong: false };

      const { rows } = await this.pool.query(
        `SELECT pts, kind, payload FROM user_updates
          WHERE user_id = $1 AND pts > $2
          ORDER BY pts
          LIMIT $3`,
        [userId, fromPts, limit + 1]
      );

      if (rows.length > limit) {
        return { updates: [], pts: current, tooLong: true };
      }

      // A hole means the rows in between were reaped, so the client cannot be
      // brought up to date by replay. Detected by counting rather than by
      // comparing timestamps: the expiry boundary moves, the arithmetic
      // does not.
      const expected = current - fromPts;
      if (rows.length < expected) {
        return { updates: [], pts: current, tooLong: true };
      }

      return {
        updates: rows.map((r) => ({ pts: Number(r.pts), kind: r.kind, ...r.payload })),
        pts: current,
        tooLong: false,
      };
    },

    /**
     * Drops expired updates. Called by the same reaper that expires messages,
     * because this table is a copy of message content and must not outlive
     * the originals.
     */
    async reapUpdates() {
      const { rowCount } = await this.pool.query(
        `DELETE FROM user_updates WHERE expires_at <= now()`
      );
      return rowCount;
    },
  };
}
