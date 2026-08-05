// ============================================================
// Vault — repos/bots.repo.js
// ============================================================
// Bot registration, token auth, the update queue, and the two query types
// (callback and inline) that make keyboards and @mentions work.
//
// A bot is a `users` row with `is_bot = true`. That reuse is what keeps the
// phase affordable: a bot is already a valid chat member, message sender and
// search result, so none of those paths need to learn what a bot is.
//
// Two rules here are security-critical:
//
//   - **Tokens are stored hashed.** The plaintext is returned once, at
//     creation, and never again. A read of this table must not yield working
//     credentials for every bot on the instance.
//
//   - **Privacy mode is the default.** `can_read_all_group_messages` is false
//     unless the owner turns it on, so adding a bot to a group does not
//     silently hand it the transcript.
//
// Retention: the update queue and both query tables hold user content and
// expire on the 24-hour schedule. Registrations and declared commands are
// configuration and persist.

import crypto from 'node:crypto';

const RETENTION_SECONDS = 86400;
// A callback that has not been answered in a couple of minutes is stale — the
// user has scrolled past whatever it was attached to.
const CALLBACK_TTL_SECONDS = 120;
const INLINE_TTL_SECONDS = 300;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createBots({ pool }) {
  return {
    pool,

    // ─── Registration ─────────────────────────────────────

    /**
     * Creates a bot: a user row plus a bots row, in one transaction.
     *
     * Returns the plaintext token exactly once. It is not recoverable
     * afterwards — the caller has to show it now or the owner must revoke and
     * reissue.
     */
    async create(ownerId, { username, name = null, description = null }) {
      const token = `${crypto.randomBytes(6).toString('hex')}:${crypto.randomBytes(24).toString('base64url')}`;

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: userRows } = await client.query(
          // A bot has no password and no keys: it never signs in as a person,
          // and giving it a password hash would imply a login path that does
          // not and should not exist.
          `INSERT INTO users (username, password_hash, identity_key, signed_prekey,
                              prekey_sig, salt, is_bot)
           VALUES ($1, '', '', '', '', '', true)
           RETURNING id, username`,
          [username]
        );
        const user = userRows[0];

        const { rows: botRows } = await client.query(
          `INSERT INTO bots (user_id, owner_id, token_hash, description)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [user.id, ownerId, hashToken(token), description]
        );

        if (name) {
          await client.query(`UPDATE users SET username = $2 WHERE id = $1`,
            [user.id, username]);
        }

        await client.query('COMMIT');
        return { ok: true, bot: this.shape(botRows[0], user), token };
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return { ok: false, reason: 'username taken' };
        throw err;
      } finally {
        client.release();
      }
    },

    shape(row, user = null) {
      if (!row) return null;
      return {
        id: row.user_id,
        username: user?.username ?? row.username ?? null,
        ownerId: row.owner_id,
        description: row.description,
        about: row.about,
        canJoinGroups: row.can_join_groups,
        canReadAllGroupMessages: row.can_read_all_group_messages,
        supportsInline: row.supports_inline,
        webhookUrl: row.webhook_url,
        createdAt: row.created_at,
      };
    },

    /**
     * Resolves a bot from its token.
     *
     * Compared by hash, and the comparison is done in SQL on an indexed
     * unique column — a hash lookup, not a scan of candidate rows, so there
     * is no timing signal to learn from.
     */
    async authenticate(token) {
      if (typeof token !== 'string' || token.length < 16) return null;
      const { rows } = await this.pool.query(
        `SELECT b.*, u.username FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE b.token_hash = $1`,
        [hashToken(token)]
      );
      return this.shape(rows[0]);
    },

    async get(botId) {
      const { rows } = await this.pool.query(
        `SELECT b.*, u.username FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE b.user_id = $1`,
        [botId]
      );
      return this.shape(rows[0]);
    },

    async getByUsername(username) {
      const { rows } = await this.pool.query(
        `SELECT b.*, u.username FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE lower(u.username) = lower($1)`,
        [username]
      );
      return this.shape(rows[0]);
    },

    async listForOwner(ownerId) {
      const { rows } = await this.pool.query(
        `SELECT b.*, u.username FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE b.owner_id = $1
          ORDER BY b.created_at DESC`,
        [ownerId]
      );
      return rows.map((r) => this.shape(r));
    },

    /** Public directory. Bots are meant to be found. */
    async search(query, { limit = 20 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT b.*, u.username FROM bots b
           JOIN users u ON u.id = b.user_id
          WHERE u.username ILIKE $1 OR b.description ILIKE $1
          LIMIT $2`,
        [`%${query}%`, limit]
      );
      return rows.map((r) => this.shape(r));
    },

    async updateSettings(botId, patch) {
      const { rows } = await this.pool.query(
        `UPDATE bots SET
           description = COALESCE($2, description),
           about = COALESCE($3, about),
           can_join_groups = COALESCE($4, can_join_groups),
           can_read_all_group_messages = COALESCE($5, can_read_all_group_messages),
           supports_inline = COALESCE($6, supports_inline)
         WHERE user_id = $1
         RETURNING *`,
        [
          botId,
          patch.description ?? null,
          patch.about ?? null,
          patch.canJoinGroups ?? null,
          patch.canReadAllGroupMessages ?? null,
          patch.supportsInline ?? null,
        ]
      );
      return this.shape(rows[0]);
    },

    /**
     * Rotates a bot's token, invalidating the old one immediately.
     *
     * The only remedy for a leaked token, so it must take effect at once
     * rather than letting the old token drain.
     */
    async rotateToken(botId) {
      const token = `${crypto.randomBytes(6).toString('hex')}:${crypto.randomBytes(24).toString('base64url')}`;
      await this.pool.query(
        `UPDATE bots SET token_hash = $2 WHERE user_id = $1`,
        [botId, hashToken(token)]
      );
      return token;
    },

    async delete(ownerId, botId) {
      // Scoped by owner in the statement rather than checked first: a
      // read-then-write here is a race that lets one account delete another's
      // bot.
      const { rowCount } = await this.pool.query(
        `DELETE FROM users WHERE id = $1 AND is_bot = true
           AND EXISTS (SELECT 1 FROM bots WHERE user_id = $1 AND owner_id = $2)`,
        [botId, ownerId]
      );
      return rowCount > 0;
    },

    // ─── Webhooks ─────────────────────────────────────────

    async setWebhook(botId, url, secret = null) {
      await this.pool.query(
        `UPDATE bots SET webhook_url = $2, webhook_secret = $3 WHERE user_id = $1`,
        [botId, url, secret]
      );
    },

    async clearWebhook(botId) {
      await this.pool.query(
        `UPDATE bots SET webhook_url = NULL, webhook_secret = NULL WHERE user_id = $1`,
        [botId]
      );
    },

    async webhookTargets() {
      const { rows } = await this.pool.query(
        `SELECT user_id, webhook_url, webhook_secret FROM bots
          WHERE webhook_url IS NOT NULL`
      );
      return rows.map((r) => ({
        botId: r.user_id, url: r.webhook_url, secret: r.webhook_secret,
      }));
    },

    // ─── Commands ─────────────────────────────────────────

    async setCommands(botId, commands) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM bot_commands WHERE bot_id = $1`, [botId]);
        let position = 0;
        for (const { command, description } of commands) {
          await client.query(
            `INSERT INTO bot_commands (bot_id, command, description, position)
             VALUES ($1, $2, $3, $4)`,
            [botId, command.replace(/^\//, ''), description, position]
          );
          position += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getCommands(botId) {
      const { rows } = await this.pool.query(
        `SELECT command, description FROM bot_commands
          WHERE bot_id = $1 ORDER BY position`,
        [botId]
      );
      return rows;
    },

    // ─── The update queue ─────────────────────────────────

    /**
     * Queues an update for a bot.
     *
     * TTL is clamped to the retention ceiling: these rows carry message
     * content, and a queue that outlived its messages would be a second,
     * permanent copy of every conversation a bot has been in.
     */
    async enqueue(botId, kind, payload, { ttlSeconds = RETENTION_SECONDS } = {}) {
      const { rows } = await this.pool.query(
        `INSERT INTO bot_updates_queue (bot_id, kind, payload, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
         RETURNING id`,
        [botId, kind, JSON.stringify(payload ?? {}),
          String(Math.min(ttlSeconds, RETENTION_SECONDS))]
      );
      return Number(rows[0].id);
    },

    /**
     * getUpdates. `offset` acknowledges everything before it, which is the
     * Bot API's confirmation model: there is no separate ack call, asking for
     * a later offset *is* the ack.
     */
    async fetchUpdates(botId, { offset = 0, limit = 100 } = {}) {
      if (offset > 0) {
        await this.pool.query(
          `UPDATE bot_updates_queue SET delivered_at = now()
            WHERE bot_id = $1 AND id < $2 AND delivered_at IS NULL`,
          [botId, offset]
        );
      }

      const { rows } = await this.pool.query(
        `SELECT id, kind, payload FROM bot_updates_queue
          WHERE bot_id = $1 AND id >= $2 AND delivered_at IS NULL
          ORDER BY id
          LIMIT $3`,
        [botId, offset, limit]
      );
      return rows.map((r) => ({
        updateId: Number(r.id), kind: r.kind, ...r.payload,
      }));
    },

    async pendingForWebhook(limit = 100) {
      const { rows } = await this.pool.query(
        `SELECT q.id, q.bot_id, q.kind, q.payload, q.attempts,
                b.webhook_url, b.webhook_secret
           FROM bot_updates_queue q
           JOIN bots b ON b.user_id = q.bot_id
          WHERE q.delivered_at IS NULL
            AND b.webhook_url IS NOT NULL
            AND (q.next_retry_at IS NULL OR q.next_retry_at <= now())
          ORDER BY q.id
          LIMIT $1`,
        [limit]
      );
      return rows.map((r) => ({
        id: Number(r.id),
        botId: r.bot_id,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
        url: r.webhook_url,
        secret: r.webhook_secret,
      }));
    },

    async markDelivered(id) {
      await this.pool.query(
        `UPDATE bot_updates_queue SET delivered_at = now() WHERE id = $1`, [id]
      );
    },

    /**
     * Records a failed webhook attempt and backs off.
     *
     * Exponential, capped. A bot whose endpoint is down must not turn into an
     * unbounded retry loop hammering someone else's server — that is how a
     * messaging platform becomes an accidental DDoS source.
     */
    async markFailed(id, attempts) {
      const backoffSeconds = Math.min(2 ** Math.min(attempts, 10), 3600);
      await this.pool.query(
        `UPDATE bot_updates_queue
            SET attempts = attempts + 1,
                next_retry_at = now() + ($2 || ' seconds')::interval
          WHERE id = $1`,
        [id, String(backoffSeconds)]
      );
    },

    // ─── Callback queries ─────────────────────────────────

    async createCallbackQuery({ botId, userId, chatId, messageSeq, data }) {
      const { rows } = await this.pool.query(
        `INSERT INTO callback_queries (bot_id, user_id, chat_id, message_seq, data, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
         RETURNING id`,
        [botId, userId, chatId, messageSeq, data, String(CALLBACK_TTL_SECONDS)]
      );
      return rows[0].id;
    },

    async answerCallbackQuery(botId, queryId) {
      // Scoped by bot and by expiry in one statement: answering another bot's
      // callback, or a stale one, must both simply fail.
      const { rowCount } = await this.pool.query(
        `UPDATE callback_queries SET answered_at = now()
          WHERE id = $1 AND bot_id = $2 AND answered_at IS NULL AND expires_at > now()`,
        [queryId, botId]
      );
      return rowCount > 0;
    },

    // ─── Inline queries ───────────────────────────────────

    async createInlineQuery({ botId, userId, query }) {
      const { rows } = await this.pool.query(
        `INSERT INTO inline_queries (bot_id, user_id, query, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
         RETURNING id`,
        [botId, userId, query, String(INLINE_TTL_SECONDS)]
      );
      return rows[0].id;
    },

    async answerInlineQuery(botId, queryId, results) {
      const { rowCount } = await this.pool.query(
        `UPDATE inline_queries SET results = $3
          WHERE id = $1 AND bot_id = $2 AND expires_at > now()`,
        [queryId, botId, JSON.stringify(results)]
      );
      return rowCount > 0;
    },

    async getInlineResults(queryId) {
      const { rows } = await this.pool.query(
        `SELECT results FROM inline_queries WHERE id = $1 AND expires_at > now()`,
        [queryId]
      );
      return rows[0]?.results ?? null;
    },

    // ─── Retention ────────────────────────────────────────

    /**
     * Clears everything past its expiry.
     *
     * Called from the same reaper pass as messages, deliberately: two
     * schedules would drift, and then diverge permanently on any failure,
     * leaving the queue as an archive of messages deleted everywhere else.
     */
    async reapBotData() {
      const results = await Promise.all([
        this.pool.query(`DELETE FROM bot_updates_queue WHERE expires_at <= now()`),
        this.pool.query(`DELETE FROM callback_queries WHERE expires_at <= now()`),
        this.pool.query(`DELETE FROM inline_queries WHERE expires_at <= now()`),
      ]);
      return results.reduce((sum, r) => sum + r.rowCount, 0);
    },
  };
}
