// ============================================================
// Vault — repos/stickers.repo.js
// ============================================================
// Sticker sets, installation, favourites and recents.
//
// The retention split is the thing to keep straight, because stickers look
// like an exception to the 24-hour rule and are not:
//
//   - A **set** is a library the user installed. It persists, and it reveals
//     nothing about any conversation.
//   - A **sticker sent in a chat** is an ordinary message and expires with
//     every other one. Messages store a *reference*, so a message expiring
//     leaves the set alone, and the set existing tells nobody it was used.
//
// Recents are where those meet. They are capped rather than expiring: an
// uncapped list of what you have been sending is exactly the metadata this
// product refuses to keep everywhere else, and it would arrive here by
// accident rather than by decision.

const RECENTS_LIMIT = 20;
const SHORT_NAME_PATTERN = /^[a-zA-Z0-9_]{3,64}$/;

export function createStickers({ pool }) {
  return {
    pool,

    // ─── Sets ─────────────────────────────────────────────

    async createSet(ownerId, { shortName, title, type = 'regular' }) {
      if (!SHORT_NAME_PATTERN.test(shortName)) {
        return { ok: false, reason: 'invalid short name' };
      }
      try {
        const { rows } = await this.pool.query(
          `INSERT INTO sticker_sets (short_name, title, owner_id, type)
           VALUES ($1, $2, $3, $4)
           RETURNING id, short_name, title, owner_id, type, is_official, installs_count`,
          [shortName, title, ownerId, type]
        );
        return { ok: true, set: this.shapeSet(rows[0]) };
      } catch (err) {
        if (err.code === '23505') return { ok: false, reason: 'short name taken' };
        throw err;
      }
    },

    shapeSet(row) {
      if (!row) return null;
      return {
        id: row.id,
        shortName: row.short_name,
        title: row.title,
        ownerId: row.owner_id,
        type: row.type,
        isOfficial: row.is_official,
        installsCount: row.installs_count,
        thumbFileId: row.thumb_file_id ?? null,
      };
    },

    shapeSticker(row) {
      if (!row) return null;
      return {
        id: row.id,
        setId: row.set_id,
        fileId: row.file_id,
        emoji: row.emoji,
        position: row.position,
        width: row.width,
        height: row.height,
        isAnimated: row.is_animated,
        isVideo: row.is_video,
      };
    },

    async getSet(setId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM sticker_sets WHERE id = $1`, [setId]
      );
      return this.shapeSet(rows[0]);
    },

    async getSetByShortName(shortName) {
      const { rows } = await this.pool.query(
        `SELECT * FROM sticker_sets WHERE lower(short_name) = lower($1)`, [shortName]
      );
      return this.shapeSet(rows[0]);
    },

    async addSticker(setId, { fileId, emoji = null, width = null, height = null,
      isAnimated = false, isVideo = false }) {
      const { rows } = await this.pool.query(
        `INSERT INTO stickers (set_id, file_id, emoji, position, width, height,
                               is_animated, is_video)
         VALUES ($1, $2, $3,
                 COALESCE((SELECT max(position) + 1 FROM stickers WHERE set_id = $1), 0),
                 $4, $5, $6, $7)
         RETURNING *`,
        [setId, fileId, emoji, width, height, isAnimated, isVideo]
      );
      return this.shapeSticker(rows[0]);
    },

    async stickersInSet(setId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM stickers WHERE set_id = $1 ORDER BY position`, [setId]
      );
      return rows.map((r) => this.shapeSticker(r));
    },

    async getSticker(stickerId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM stickers WHERE id = $1`, [stickerId]
      );
      return this.shapeSticker(rows[0]);
    },

    // ─── Installation ─────────────────────────────────────

    async install(userId, setId) {
      // The counter is bumped only on a genuine install, so re-adding a set
      // you already have does not inflate it.
      const { rowCount } = await this.pool.query(
        `INSERT INTO user_sticker_sets (user_id, set_id, position)
         VALUES ($1, $2,
                 COALESCE((SELECT max(position) + 1 FROM user_sticker_sets WHERE user_id = $1), 0))
         ON CONFLICT (user_id, set_id) DO NOTHING`,
        [userId, setId]
      );
      if (rowCount > 0) {
        await this.pool.query(
          `UPDATE sticker_sets SET installs_count = installs_count + 1 WHERE id = $1`,
          [setId]
        );
      }
      return rowCount > 0;
    },

    async uninstall(userId, setId) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM user_sticker_sets WHERE user_id = $1 AND set_id = $2`,
        [userId, setId]
      );
      if (rowCount > 0) {
        await this.pool.query(
          // GREATEST guards against a counter drifting below zero if an
          // install row were ever removed without going through here.
          `UPDATE sticker_sets SET installs_count = GREATEST(installs_count - 1, 0)
            WHERE id = $1`,
          [setId]
        );
      }
      return rowCount > 0;
    },

    async isInstalled(userId, setId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM user_sticker_sets WHERE user_id = $1 AND set_id = $2`,
        [userId, setId]
      );
      return rows.length > 0;
    },

    /** A user's installed sets, each with its stickers, for the picker. */
    async installedSets(userId) {
      const { rows } = await this.pool.query(
        `SELECT s.* FROM user_sticker_sets us
           JOIN sticker_sets s ON s.id = us.set_id
          WHERE us.user_id = $1
          ORDER BY us.position`,
        [userId]
      );

      const sets = [];
      for (const row of rows) {
        const set = this.shapeSet(row);
        set.stickers = await this.stickersInSet(set.id);
        sets.push(set);
      }
      return sets;
    },

    async searchSets(query, { limit = 20 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT * FROM sticker_sets
          WHERE short_name ILIKE $1 OR title ILIKE $1
          ORDER BY installs_count DESC
          LIMIT $2`,
        [`%${query}%`, limit]
      );
      return rows.map((r) => this.shapeSet(r));
    },

    // ─── Favourites and recents ───────────────────────────

    async favorite(userId, stickerId) {
      await this.pool.query(
        `INSERT INTO favorite_stickers (user_id, sticker_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, stickerId]
      );
    },

    async unfavorite(userId, stickerId) {
      await this.pool.query(
        `DELETE FROM favorite_stickers WHERE user_id = $1 AND sticker_id = $2`,
        [userId, stickerId]
      );
    },

    async favorites(userId) {
      const { rows } = await this.pool.query(
        `SELECT s.* FROM favorite_stickers f
           JOIN stickers s ON s.id = f.sticker_id
          WHERE f.user_id = $1
          ORDER BY f.added_at DESC`,
        [userId]
      );
      return rows.map((r) => this.shapeSticker(r));
    },

    /**
     * Records a sticker as recently used, and trims the list.
     *
     * The cap is the point. Left unbounded this becomes a durable record of
     * what someone has been sending — metadata the rest of this product goes
     * out of its way not to retain — so the trim is a privacy control, not
     * housekeeping.
     */
    async touchRecent(userId, stickerId) {
      await this.pool.query(
        `INSERT INTO recent_stickers (user_id, sticker_id, used_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, sticker_id) DO UPDATE SET used_at = now()`,
        [userId, stickerId]
      );
      await this.pool.query(
        `DELETE FROM recent_stickers
          WHERE user_id = $1 AND sticker_id NOT IN (
            SELECT sticker_id FROM recent_stickers
             WHERE user_id = $1 ORDER BY used_at DESC LIMIT $2
          )`,
        [userId, RECENTS_LIMIT]
      );
    },

    async recents(userId) {
      const { rows } = await this.pool.query(
        `SELECT s.* FROM recent_stickers r
           JOIN stickers s ON s.id = r.sticker_id
          WHERE r.user_id = $1
          ORDER BY r.used_at DESC`,
        [userId]
      );
      return rows.map((r) => this.shapeSticker(r));
    },

    async clearRecents(userId) {
      await this.pool.query(`DELETE FROM recent_stickers WHERE user_id = $1`, [userId]);
    },

    /**
     * Stickers suggested for an emoji.
     *
     * Scoped to sets the user has installed. Suggesting from every set on the
     * server would offer stickers the user cannot send and would leak which
     * sets exist to someone who never installed any.
     */
    async suggestForEmoji(userId, emoji, { limit = 12 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT s.* FROM stickers s
           JOIN user_sticker_sets us ON us.set_id = s.set_id AND us.user_id = $1
          WHERE s.emoji = $2
          LIMIT $3`,
        [userId, emoji, limit]
      );
      return rows.map((r) => this.shapeSticker(r));
    },
  };
}
