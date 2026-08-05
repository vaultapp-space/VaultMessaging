// ============================================================
// Vault — repos/phase8.repo.js
// ============================================================
// Voice chats, forum topics and stories.
//
// **Voice chats are capped, and the cap is honest.** The media plane is the
// existing 1:1 WebRTC mesh, which is O(n²) connections and degrades badly
// past a handful of participants. Scaling further means running an SFU
// (mediasoup or LiveKit) — new infrastructure, not new code. So the room
// model is complete and the participant limit is enforced here, rather than
// letting a call quietly fall apart at eight people. When an SFU is added,
// this cap is the only thing that needs to move.
//
// **Stories are the cheapest thing in the plan** precisely because the whole
// product is built around expiry: a story is media with a TTL and a viewer
// list, and the reaper already handles the first half.

const MAX_VOICE_PARTICIPANTS = 4;
const STORY_TTL_SECONDS = 86400;

export function createPhase8({ pool }) {
  return {
    pool,
    maxVoiceParticipants: MAX_VOICE_PARTICIPANTS,

    // ─── Voice chats ──────────────────────────────────────

    /**
     * Starts a voice chat in a chat, or returns the live one.
     *
     * A partial unique index enforces one live call per chat, so two people
     * pressing "start" at the same moment cannot create two rooms that each
     * think they are the call.
     */
    async startVoiceChat(chatId, startedBy, { title = null } = {}) {
      const existing = await this.liveVoiceChat(chatId);
      if (existing) return { ok: true, voiceChat: existing, created: false };

      try {
        const { rows } = await this.pool.query(
          `INSERT INTO voice_chats (chat_id, title, started_by)
           VALUES ($1, $2, $3)
           RETURNING id, chat_id, title, started_by, started_at, ended_at`,
          [chatId, title, startedBy]
        );
        return { ok: true, voiceChat: this.shapeVoiceChat(rows[0]), created: true };
      } catch (err) {
        // Lost the race against another starter; theirs is the call.
        if (err.code === '23505') {
          return { ok: true, voiceChat: await this.liveVoiceChat(chatId), created: false };
        }
        throw err;
      }
    },

    shapeVoiceChat(row) {
      if (!row) return null;
      return {
        id: row.id,
        chatId: row.chat_id,
        title: row.title,
        startedBy: row.started_by,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        participantsCount: row.participants_count === undefined
          ? undefined
          : Number(row.participants_count),
      };
    },

    async liveVoiceChat(chatId) {
      const { rows } = await this.pool.query(
        `SELECT v.*, (SELECT count(*) FROM voice_chat_participants p
                       WHERE p.voice_chat_id = v.id AND p.left_at IS NULL)
                     AS participants_count
           FROM voice_chats v
          WHERE v.chat_id = $1 AND v.ended_at IS NULL`,
        [chatId]
      );
      return this.shapeVoiceChat(rows[0]);
    },

    async getVoiceChat(voiceChatId) {
      const { rows } = await this.pool.query(
        `SELECT v.*, (SELECT count(*) FROM voice_chat_participants p
                       WHERE p.voice_chat_id = v.id AND p.left_at IS NULL)
                     AS participants_count
           FROM voice_chats v WHERE v.id = $1`,
        [voiceChatId]
      );
      return this.shapeVoiceChat(rows[0]);
    },

    /**
     * Joins a voice chat.
     *
     * The cap is checked and the insert done in one transaction, so several
     * people joining at once cannot each see room and collectively overfill
     * it — which with a mesh topology is how a call becomes unusable for
     * everyone already in it.
     */
    async joinVoiceChat(voiceChatId, userId) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: live } = await client.query(
          `SELECT ended_at FROM voice_chats WHERE id = $1 FOR UPDATE`, [voiceChatId]
        );
        if (live.length === 0 || live[0].ended_at) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'that call has ended' };
        }

        const { rows: countRows } = await client.query(
          `SELECT count(*)::int AS n FROM voice_chat_participants
            WHERE voice_chat_id = $1 AND left_at IS NULL AND user_id <> $2`,
          [voiceChatId, userId]
        );
        if (countRows[0].n >= MAX_VOICE_PARTICIPANTS) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'this call is full' };
        }

        await client.query(
          `INSERT INTO voice_chat_participants (voice_chat_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (voice_chat_id, user_id) DO UPDATE
              SET left_at = NULL, joined_at = now()`,
          [voiceChatId, userId]
        );

        await client.query('COMMIT');
        return { ok: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async leaveVoiceChat(voiceChatId, userId) {
      await this.pool.query(
        `UPDATE voice_chat_participants SET left_at = now()
          WHERE voice_chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [voiceChatId, userId]
      );

      // An empty call is over. Leaving it open would show a live call nobody
      // is in, which people then join expecting to find someone.
      const { rows } = await this.pool.query(
        `SELECT count(*)::int AS n FROM voice_chat_participants
          WHERE voice_chat_id = $1 AND left_at IS NULL`,
        [voiceChatId]
      );
      if (rows[0].n === 0) await this.endVoiceChat(voiceChatId);
      return rows[0].n;
    },

    async endVoiceChat(voiceChatId) {
      await this.pool.query(
        `UPDATE voice_chats SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`,
        [voiceChatId]
      );
    },

    async voiceParticipants(voiceChatId) {
      const { rows } = await this.pool.query(
        `SELECT p.user_id, p.is_muted, p.muted_by_admin, p.is_speaking, p.joined_at,
                u.username
           FROM voice_chat_participants p
           JOIN users u ON u.id = p.user_id
          WHERE p.voice_chat_id = $1 AND p.left_at IS NULL
          ORDER BY p.joined_at`,
        [voiceChatId]
      );
      return rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        isMuted: r.is_muted,
        mutedByAdmin: r.muted_by_admin,
        isSpeaking: r.is_speaking,
        joinedAt: r.joined_at,
      }));
    },

    /**
     * Sets mute state.
     *
     * `byAdmin` is a separate column, not a stronger value of the same one:
     * collapsing them would let a participant un-mute themselves after a
     * moderator muted them, which is the one thing moderation muting is for.
     */
    async setVoiceMute(voiceChatId, userId, muted, { byAdmin = false } = {}) {
      if (byAdmin) {
        await this.pool.query(
          `UPDATE voice_chat_participants
              SET muted_by_admin = $3, is_muted = $3
            WHERE voice_chat_id = $1 AND user_id = $2`,
          [voiceChatId, userId, muted]
        );
        return { ok: true };
      }

      const { rows } = await this.pool.query(
        `SELECT muted_by_admin FROM voice_chat_participants
          WHERE voice_chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [voiceChatId, userId]
      );
      if (rows.length === 0) return { ok: false, reason: 'not in this call' };
      if (rows[0].muted_by_admin && !muted) {
        return { ok: false, reason: 'you were muted by an admin' };
      }

      await this.pool.query(
        `UPDATE voice_chat_participants SET is_muted = $3
          WHERE voice_chat_id = $1 AND user_id = $2`,
        [voiceChatId, userId, muted]
      );
      return { ok: true };
    },

    // ─── Forum topics ─────────────────────────────────────

    async createTopic(chatId, createdBy, { title, iconEmoji = null }) {
      const { rows } = await this.pool.query(
        `INSERT INTO forum_topics (chat_id, title, icon_emoji, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING chat_id, topic_id, title, icon_emoji, created_by, created_at,
                   closed_at, is_pinned, root_seq`,
        [chatId, title, iconEmoji, createdBy]
      );
      return this.shapeTopic(rows[0]);
    },

    shapeTopic(row) {
      if (!row) return null;
      return {
        chatId: row.chat_id,
        topicId: Number(row.topic_id),
        title: row.title,
        iconEmoji: row.icon_emoji,
        createdBy: row.created_by,
        createdAt: row.created_at,
        closed: Boolean(row.closed_at),
        isPinned: row.is_pinned,
        rootSeq: row.root_seq === null ? null : Number(row.root_seq),
      };
    },

    async listTopics(chatId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM forum_topics WHERE chat_id = $1
          ORDER BY is_pinned DESC, created_at DESC`,
        [chatId]
      );
      return rows.map((r) => this.shapeTopic(r));
    },

    async getTopic(chatId, topicId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM forum_topics WHERE chat_id = $1 AND topic_id = $2`,
        [chatId, topicId]
      );
      return this.shapeTopic(rows[0]);
    },

    async setTopicClosed(chatId, topicId, closed) {
      await this.pool.query(
        `UPDATE forum_topics SET closed_at = $3 WHERE chat_id = $1 AND topic_id = $2`,
        [chatId, topicId, closed ? new Date() : null]
      );
    },

    async setTopicPinned(chatId, topicId, pinned) {
      await this.pool.query(
        `UPDATE forum_topics SET is_pinned = $3 WHERE chat_id = $1 AND topic_id = $2`,
        [chatId, topicId, pinned]
      );
    },

    async deleteTopic(chatId, topicId) {
      await this.pool.query(
        `DELETE FROM forum_topics WHERE chat_id = $1 AND topic_id = $2`,
        [chatId, topicId]
      );
    },

    /** The first message in a topic becomes its root, for deep links. */
    async setTopicRoot(chatId, topicId, seq) {
      await this.pool.query(
        `UPDATE forum_topics SET root_seq = COALESCE(root_seq, $3)
          WHERE chat_id = $1 AND topic_id = $2`,
        [chatId, topicId, seq]
      );
    },

    async setForum(chatId, isForum) {
      await this.pool.query(
        `UPDATE chats SET is_forum = $2 WHERE id = $1`, [chatId, isForum]
      );
    },

    // ─── Contacts ─────────────────────────────────────────
    // One-directional on purpose: adding someone is a private annotation on
    // your own account, not a relationship they agree to or are told about.

    async addContact(ownerId, contactId, { firstName = null, lastName = null } = {}) {
      if (ownerId === contactId) return false;
      const { rowCount } = await this.pool.query(
        `INSERT INTO contacts (owner_id, contact_id, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_id, contact_id) DO UPDATE
            SET first_name = COALESCE($3, contacts.first_name),
                last_name = COALESCE($4, contacts.last_name)`,
        [ownerId, contactId, firstName, lastName]
      );
      return rowCount > 0;
    },

    async removeContact(ownerId, contactId) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2`,
        [ownerId, contactId]
      );
      return rowCount > 0;
    },

    async listContacts(ownerId) {
      const { rows } = await this.pool.query(
        `SELECT c.contact_id, c.first_name, c.last_name, c.added_at, u.username
           FROM contacts c
           JOIN users u ON u.id = c.contact_id
          WHERE c.owner_id = $1
          ORDER BY u.username`,
        [ownerId]
      );
      return rows.map((r) => ({
        id: r.contact_id,
        username: r.username,
        firstName: r.first_name,
        lastName: r.last_name,
        addedAt: r.added_at,
      }));
    },

    // ─── Stories ──────────────────────────────────────────

    /**
     * Posts a story.
     *
     * The TTL is clamped rather than trusted. A story is content like any
     * other and is not exempt from the ceiling — "24 hours" being a story's
     * own convention makes it tempting to treat this as a special case, and
     * it is not one.
     */
    async createStory(userId, { media, caption = null, privacy = 'contacts',
      ttlSeconds = STORY_TTL_SECONDS }) {
      const { rows } = await this.pool.query(
        `INSERT INTO stories (user_id, media, caption, privacy, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
         RETURNING id, user_id, media, caption, privacy, created_at, expires_at`,
        [userId, JSON.stringify(media), caption, privacy,
          String(Math.min(ttlSeconds, STORY_TTL_SECONDS))]
      );
      return this.shapeStory(rows[0]);
    },

    shapeStory(row) {
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        username: row.username ?? null,
        media: row.media,
        caption: row.caption,
        privacy: row.privacy,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        viewsCount: row.views_count === undefined ? undefined : Number(row.views_count),
      };
    },

    async getStory(storyId) {
      const { rows } = await this.pool.query(
        `SELECT s.*, u.username FROM stories s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > now()`,
        [storyId]
      );
      return this.shapeStory(rows[0]);
    },

    /** A user's own stories, with view counts. */
    async storiesFor(userId) {
      const { rows } = await this.pool.query(
        `SELECT s.*, u.username,
                (SELECT count(*) FROM story_views v WHERE v.story_id = s.id) AS views_count
           FROM stories s
           JOIN users u ON u.id = s.user_id
          WHERE s.user_id = $1 AND s.expires_at > now()
          ORDER BY s.created_at`,
        [userId]
      );
      return rows.map((r) => this.shapeStory(r));
    },

    /**
     * The stories this viewer is allowed to see.
     *
     * Privacy is applied in the query rather than filtered afterwards. A
     * "fetch then filter" version leaks through any code path that forgets
     * the filter, and there is no reason to hand the application rows it must
     * not show.
     */
    async feedFor(viewerId) {
      const { rows } = await this.pool.query(
        `SELECT s.*, u.username,
                (SELECT count(*) FROM story_views v WHERE v.story_id = s.id) AS views_count
           FROM stories s
           JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > now()
            AND (
              s.user_id = $1
              OR s.privacy = 'everyone'
              OR (s.privacy = 'contacts' AND EXISTS (
                    SELECT 1 FROM contacts c
                     WHERE c.owner_id = s.user_id AND c.contact_id = $1))
            )
            AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = s.user_id AND b.blocked_id = $1)
                  OR (b.blocker_id = $1 AND b.blocked_id = s.user_id)
            )
          ORDER BY s.created_at DESC`,
        [viewerId]
      );
      return rows.map((r) => this.shapeStory(r));
    },

    /**
     * Whether a viewer may see the *bytes* of a story image.
     *
     * The story row is privacy-scoped, but its image was served by an
     * unauthenticated endpoint — so a "contacts only" story's picture was
     * readable by anyone holding the URL, and the privacy setting only ever
     * governed the caption and the ring in the UI.
     *
     * Returns true for a file no story references, which is how sticker
     * images stay readable: those are public assets by design.
     */
    async canViewMediaFile(fileId, viewerId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM stories s
          WHERE s.media->>'fileId' = $1
            AND s.expires_at > now()
            AND NOT (
              s.user_id = $2
              OR s.privacy = 'everyone'
              OR (s.privacy = 'contacts' AND EXISTS (
                    SELECT 1 FROM contacts c
                     WHERE c.owner_id = s.user_id AND c.contact_id = $2))
            )
          LIMIT 1`,
        [fileId, viewerId]
      );
      // A row here is a story this viewer may *not* see. Absence means either
      // they may see it, or no story claims the file at all.
      return rows.length === 0;
    },

    async recordStoryView(storyId, viewerId) {
      await this.pool.query(
        `INSERT INTO story_views (story_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [storyId, viewerId]
      );
    },

    /** Only the author may see who looked. */
    async storyViewers(storyId, authorId) {
      const { rows } = await this.pool.query(
        `SELECT u.id, u.username, v.viewed_at
           FROM story_views v
           JOIN users u ON u.id = v.user_id
           JOIN stories s ON s.id = v.story_id
          WHERE v.story_id = $1 AND s.user_id = $2
          ORDER BY v.viewed_at DESC`,
        [storyId, authorId]
      );
      return rows.map((r) => ({
        userId: r.id, username: r.username, viewedAt: r.viewed_at,
      }));
    },

    async deleteStory(userId, storyId) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM stories WHERE id = $1 AND user_id = $2`, [storyId, userId]
      );
      return rowCount > 0;
    },

    /** Reaps expired stories. Views cascade, so no separate cleanup. */
    async reapStories() {
      const { rowCount } = await this.pool.query(
        `DELETE FROM stories WHERE expires_at <= now()`
      );
      return rowCount;
    },
  };
}
