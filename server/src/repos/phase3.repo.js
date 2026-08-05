// ============================================================
// Vault — repos/phase3.repo.js
// ============================================================
// Admin rights, revocable invites, bans, polls, scheduling and folders.
//
// The rights model is the security-critical part. It is deliberately
// capability-based rather than a role enum: "owner", "admin" and "member" are
// shorthands that expand into an explicit set, so a future role does not
// require finding every `role === 'admin'` check in the codebase.
//
// Rights are always resolved server-side from `chat_members`. A client's idea
// of its own role is a UI hint and is never trusted.

import crypto from 'node:crypto';

// What each named role can do. `owner` is deliberately not "everything":
// listing them explicitly means adding a right does not silently grant it.
const ROLE_RIGHTS = {
  owner: ['changeInfo', 'post', 'editOthers', 'deleteOthers', 'ban', 'invite', 'pin', 'promote', 'manageInvites'],
  admin: ['changeInfo', 'post', 'deleteOthers', 'ban', 'invite', 'pin', 'manageInvites'],
  member: ['post', 'invite'],
  restricted: [],
  banned: [],
};

export const ALL_RIGHTS = ROLE_RIGHTS.owner;

export function createPhase3({ pool }) {
  return {
    pool,

    // ─── Rights ───────────────────────────────────────────

    /**
     * Resolves what a user may do in a chat.
     *
     * Per-member `rights` overrides layer on top of the role default, so an
     * individual can be granted or denied a single capability without
     * inventing a new role.
     */
    async rightsFor(chatId, userId) {
      const { rows } = await this.pool.query(
        `SELECT cm.role, cm.rights, c.type, c.created_by
           FROM chat_members cm
           JOIN chats c ON c.id = cm.chat_id
          WHERE cm.chat_id = $1 AND cm.user_id = $2`,
        [chatId, userId]
      );
      if (rows.length === 0) return null;

      const { role, rights: overrides, type, created_by: createdBy } = rows[0];

      // A private chat has no hierarchy: both participants are equals, and
      // treating one as an "owner" would let them moderate the other.
      if (type === 'private') {
        return new Set(['post', 'pin']);
      }

      const base = ROLE_RIGHTS[role] || ROLE_RIGHTS.member;
      const granted = new Set(base);

      // The creator keeps owner rights even if their row says otherwise —
      // otherwise a bad migration could leave a group with no owner at all.
      if (createdBy === userId) {
        for (const right of ROLE_RIGHTS.owner) granted.add(right);
      }

      for (const [right, allowed] of Object.entries(overrides || {})) {
        if (allowed) granted.add(right);
        else granted.delete(right);
      }

      return granted;
    },

    async can(chatId, userId, right) {
      const rights = await this.rightsFor(chatId, userId);
      return Boolean(rights && rights.has(right));
    },

    async setRole(chatId, userId, role) {
      if (!ROLE_RIGHTS[role]) throw new Error(`Unknown role: ${role}`);
      const { rows } = await this.pool.query(
        `UPDATE chat_members SET role = $3
          WHERE chat_id = $1 AND user_id = $2
          RETURNING chat_id, user_id, role`,
        [chatId, userId, role]
      );
      return rows[0] || null;
    },

    // ─── Invites ──────────────────────────────────────────
    //
    // Replaces chats.join_key, which was a permanent bearer secret with no
    // expiry, no usage limit, no revocation and no record of who used it.

    async createInvite(chatId, createdBy, { expiresAt = null, usageLimit = null, title = null } = {}) {
      // 32 bytes of randomness, url-safe. Long enough that guessing is not a
      // consideration, which matters because possession alone grants entry.
      const hash = crypto.randomBytes(24).toString('base64url');

      const { rows } = await this.pool.query(
        `INSERT INTO chat_invites (hash, chat_id, created_by, expires_at, usage_limit, title)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING hash, chat_id, expires_at, usage_limit, usage_count, revoked, title, created_at`,
        [hash, chatId, createdBy, expiresAt, usageLimit, title]
      );
      return rows[0];
    },

    async listInvites(chatId) {
      const { rows } = await this.pool.query(
        `SELECT hash, created_by, created_at, expires_at, usage_limit, usage_count, revoked, title
           FROM chat_invites WHERE chat_id = $1 ORDER BY created_at DESC`,
        [chatId]
      );
      return rows;
    },

    async revokeInvite(hash) {
      const { rows } = await this.pool.query(
        `UPDATE chat_invites SET revoked = true WHERE hash = $1 RETURNING hash, chat_id`,
        [hash]
      );
      return rows[0] || null;
    },

    /**
     * Redeems an invite, atomically.
     *
     * The usage check and increment happen in one statement so two people
     * racing on the last slot of a limited invite cannot both get in.
     */
    async redeemInvite(hash, userId) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `UPDATE chat_invites
              SET usage_count = usage_count + 1
            WHERE hash = $1
              AND revoked = false
              AND (expires_at IS NULL OR expires_at > now())
              AND (usage_limit IS NULL OR usage_count < usage_limit)
            RETURNING chat_id, usage_count, usage_limit`,
          [hash]
        );

        if (rows.length === 0) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invite is not valid' };
        }

        const chatId = rows[0].chat_id;

        // A ban must survive an invite. Otherwise removing someone achieves
        // nothing: they rejoin with any link they still have.
        const banned = await client.query(
          `SELECT 1 FROM chat_banned
            WHERE chat_id = $1 AND user_id = $2
              AND (until IS NULL OR until > now())`,
          [chatId, userId]
        );
        if (banned.rows.length > 0) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'you cannot join this chat' };
        }

        await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [chatId, userId]
        );
        await client.query(
          `INSERT INTO chat_invite_uses (hash, user_id) VALUES ($1, $2)
           ON CONFLICT (hash, user_id) DO NOTHING`,
          [hash, userId]
        );
        await client.query(
          `UPDATE chats SET members_count =
             (SELECT count(*) FROM chat_members WHERE chat_id = $1) WHERE id = $1`,
          [chatId]
        );

        await client.query('COMMIT');
        return { ok: true, chatId };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // ─── Bans ─────────────────────────────────────────────

    async ban(chatId, userId, bannedBy, { until = null } = {}) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO chat_banned (chat_id, user_id, until, banned_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chat_id, user_id) DO UPDATE
              SET until = EXCLUDED.until, banned_by = EXCLUDED.banned_by, banned_at = now()`,
          [chatId, userId, until, bannedBy]
        );
        await client.query(
          `DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
          [chatId, userId]
        );
        await client.query(
          `UPDATE chats SET members_count =
             (SELECT count(*) FROM chat_members WHERE chat_id = $1) WHERE id = $1`,
          [chatId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async unban(chatId, userId) {
      await this.pool.query(
        `DELETE FROM chat_banned WHERE chat_id = $1 AND user_id = $2`, [chatId, userId]
      );
    },

    async isBanned(chatId, userId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM chat_banned
          WHERE chat_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())`,
        [chatId, userId]
      );
      return rows.length > 0;
    },

    // ─── Polls ────────────────────────────────────────────

    async createPoll(chatId, seq, { question, options, isAnonymous = true, allowsMultiple = false }) {
      const shaped = options.map((text, id) => ({ id, text }));
      const { rows } = await this.pool.query(
        `INSERT INTO polls (chat_id, seq, question, options, is_anonymous, allows_multiple)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, question, options, is_anonymous, allows_multiple`,
        [chatId, seq, question, JSON.stringify(shaped), isAnonymous, allowsMultiple]
      );
      return rows[0];
    },

    async vote(pollId, userId, optionIds) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `SELECT allows_multiple, closed_at, jsonb_array_length(options) AS option_count
             FROM polls WHERE id = $1`,
          [pollId]
        );
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'poll not found' };
        }
        const poll = rows[0];
        if (poll.closed_at) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'poll is closed' };
        }

        const chosen = poll.allows_multiple ? optionIds : optionIds.slice(0, 1);
        if (chosen.some((id) => id < 0 || id >= poll.option_count)) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'invalid option' };
        }

        // Replacing rather than adding: changing your mind should not leave
        // the old vote behind, and a single-choice poll must never end up
        // with two votes from one person.
        await client.query(`DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2`, [pollId, userId]);
        for (const optionId of chosen) {
          await client.query(
            `INSERT INTO poll_votes (poll_id, user_id, option_id) VALUES ($1, $2, $3)`,
            [pollId, userId, optionId]
          );
        }

        await client.query('COMMIT');
        return { ok: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getPollResults(pollId, viewerId) {
      const { rows: pollRows } = await this.pool.query(
        `SELECT id, question, options, is_anonymous, allows_multiple, closed_at
           FROM polls WHERE id = $1`,
        [pollId]
      );
      if (pollRows.length === 0) return null;
      const poll = pollRows[0];

      const { rows: voteRows } = await this.pool.query(
        `SELECT option_id, count(*)::int AS votes,
                bool_or(user_id = $2) AS mine
           FROM poll_votes WHERE poll_id = $1 GROUP BY option_id`,
        [pollId, viewerId]
      );
      const byOption = new Map(voteRows.map((r) => [r.option_id, r]));

      const { rows: totalRows } = await this.pool.query(
        `SELECT count(DISTINCT user_id)::int AS voters FROM poll_votes WHERE poll_id = $1`,
        [pollId]
      );

      return {
        id: poll.id,
        question: poll.question,
        isAnonymous: poll.is_anonymous,
        allowsMultiple: poll.allows_multiple,
        closed: Boolean(poll.closed_at),
        totalVoters: totalRows[0].voters,
        options: poll.options.map((option) => ({
          id: option.id,
          text: option.text,
          votes: byOption.get(option.id)?.votes ?? 0,
          chosenByMe: Boolean(byOption.get(option.id)?.mine),
        })),
      };
    },

    async closePoll(pollId) {
      await this.pool.query(
        `UPDATE polls SET closed_at = now() WHERE id = $1 AND closed_at IS NULL`, [pollId]
      );
    },

    async getPollForMessage(chatId, seq) {
      const { rows } = await this.pool.query(
        `SELECT id FROM polls WHERE chat_id = $1 AND seq = $2`, [chatId, seq]
      );
      return rows[0]?.id || null;
    },

    // ─── Folders ──────────────────────────────────────────

    async createFolder(userId, { title, emoji = null }) {
      const { rows } = await this.pool.query(
        `INSERT INTO folders (user_id, title, emoji, position)
         VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM folders WHERE user_id = $1), 0))
         RETURNING id, title, emoji, position`,
        [userId, title, emoji]
      );
      return rows[0];
    },

    async listFolders(userId) {
      const { rows } = await this.pool.query(
        `SELECT f.id, f.title, f.emoji, f.position,
                COALESCE(array_agg(fc.chat_id) FILTER (WHERE fc.chat_id IS NOT NULL), '{}') AS chat_ids
           FROM folders f
           LEFT JOIN folder_chats fc ON fc.folder_id = f.id
          WHERE f.user_id = $1
          GROUP BY f.id
          ORDER BY f.position`,
        [userId]
      );
      return rows.map((r) => ({
        id: r.id, title: r.title, emoji: r.emoji, position: r.position, chatIds: r.chat_ids,
      }));
    },

    async deleteFolder(userId, folderId) {
      await this.pool.query(
        `DELETE FROM folders WHERE id = $1 AND user_id = $2`, [folderId, userId]
      );
    },

    async setFolderChats(userId, folderId, chatIds) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const owned = await client.query(
          `SELECT 1 FROM folders WHERE id = $1 AND user_id = $2`, [folderId, userId]
        );
        if (owned.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }

        await client.query(`DELETE FROM folder_chats WHERE folder_id = $1`, [folderId]);
        for (const chatId of chatIds) {
          // Only chats the user is actually in — a folder must not become a
          // way to reference a conversation you have no access to.
          await client.query(
            `INSERT INTO folder_chats (folder_id, chat_id)
             SELECT $1, $2 WHERE EXISTS (
               SELECT 1 FROM chat_members WHERE chat_id = $2 AND user_id = $3
             ) ON CONFLICT DO NOTHING`,
            [folderId, chatId, userId]
          );
        }
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // ─── Scheduled messages ───────────────────────────────

    /** Messages whose scheduled time has arrived. Polled by the worker. */
    async dueScheduledMessages(limit = 50) {
      const { rows } = await this.pool.query(
        `SELECT id, chat_id, seq, sender_id, body, entities, media
           FROM messages
          WHERE scheduled_at IS NOT NULL
            AND scheduled_at <= now()
            AND deleted_at IS NULL
          ORDER BY scheduled_at
          LIMIT $1`,
        [limit]
      );
      return rows;
    },

    // ─── View-once media ──────────────────────────────────

    /**
     * Records that someone opened a message and, if it is view-once and the
     * viewer is not its author, clears its content.
     *
     * Two rules make this behave the way people expect:
     *
     *   - The author viewing their own message never consumes it. Otherwise
     *     scrolling past your own send would destroy it.
     *   - A second look by the same viewer is allowed. The content is cleared
     *     on the *first* view, so re-opening finds the tombstone; what must
     *     not happen is one person's view destroying it before someone else
     *     in a group has seen it at all — which is why the clear only fires
     *     once every non-author member has viewed.
     *
     * Returns { consumed } so the caller knows whether to broadcast.
     */
    async recordView(chatId, seq, viewerId) {
      const { rows: msgRows } = await this.pool.query(
        `SELECT sender_id, view_once, body IS NULL AND media IS NULL AS already_cleared
           FROM messages WHERE chat_id = $1 AND seq = $2`,
        [chatId, seq]
      );
      if (msgRows.length === 0) return { ok: false, reason: 'not found' };
      const message = msgRows[0];

      await this.pool.query(
        `INSERT INTO message_views (chat_id, seq, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (chat_id, seq, user_id) DO NOTHING`,
        [chatId, seq, viewerId]
      );

      if (!message.view_once || message.already_cleared) {
        return { ok: true, consumed: false };
      }
      if (message.sender_id === viewerId) {
        return { ok: true, consumed: false };
      }

      // Everyone who could see it has now seen it.
      const { rows: pending } = await this.pool.query(
        `SELECT count(*)::int AS remaining
           FROM chat_members cm
          WHERE cm.chat_id = $1
            AND cm.user_id <> $2
            AND NOT EXISTS (
              SELECT 1 FROM message_views v
               WHERE v.chat_id = $1 AND v.seq = $3 AND v.user_id = cm.user_id
            )`,
        [chatId, message.sender_id, seq]
      );
      if (pending[0].remaining > 0) return { ok: true, consumed: false };

      // Cleared, not deleted: `deleted_at` would hide it from history
      // entirely, and a view-once message should leave a visible "opened"
      // marker where it was.
      await this.pool.query(
        `UPDATE messages SET body = NULL, media = NULL, entities = NULL
          WHERE chat_id = $1 AND seq = $2`,
        [chatId, seq]
      );
      return { ok: true, consumed: true };
    },

    /**
     * Marks a scheduled message as delivered.
     *
     * `expires_at` is recomputed from *now*, not from when it was created:
     * a message scheduled for +23h would otherwise be reaped an hour after
     * arriving, which is not what "expires 24h after it was sent" means.
     */
    async releaseScheduledMessage(id, ttlSeconds = 86400) {
      const { rows } = await this.pool.query(
        `UPDATE messages
            SET scheduled_at = NULL,
                sent_at = now(),
                expires_at = now() + ($2 || ' seconds')::interval
          WHERE id = $1
          RETURNING id, chat_id, seq, sender_id, body, sent_at, expires_at`,
        [id, String(Math.min(ttlSeconds, 86400))]
      );
      return rows[0] || null;
    },
  };
}
