// ============================================================
// Vault — repos/reactions.repo.js
// ============================================================
// Reactions for cloud chats.
//
// Secret chats never reach here: their reactions travel as encrypted `t:'op'`
// envelopes and are applied client-side, because the server cannot read the
// message being reacted to and has no business holding a plaintext record of
// who reacted with what in an end-to-end encrypted conversation.
//
// Every mutation rewrites the denormalised `messages.reactions` summary in the
// same transaction. That column is what the message list renders from, so if
// it ever drifts from the rows here the UI silently lies.

const MAX_EMOJI_LENGTH = 64;

export function createReactions({ pool }) {
  // Recomputes the summary from the rows. Always called inside the transaction
  // that changed them, so the column and the rows cannot drift.
  async function refreshSummary(client, chatId, seq) {
    const { rows } = await client.query(
      `SELECT COALESCE(
                  jsonb_agg(entry ORDER BY entry->>'emoji'),
                  '[]'::jsonb
                ) AS summary
           FROM (
                SELECT jsonb_build_object(
                         'emoji', emoji,
                         'count', count(*),
                         'users', jsonb_agg(user_id ORDER BY created_at)
                       ) AS entry
                  FROM reactions
                 WHERE chat_id = $1 AND seq = $2
                 GROUP BY emoji
           ) grouped`,
      [chatId, seq]
    );
    const summary = rows[0]?.summary ?? [];
    await client.query(
      `UPDATE messages SET reactions = $3 WHERE chat_id = $1 AND seq = $2`,
      [chatId, seq, JSON.stringify(summary)]
    );
    return summary;
  }

  return {
    pool,

    // Idempotent: reacting twice with the same emoji is a no-op rather than an
    // error, because a double-tap should not fail.
    async add(chatId, seq, userId, emoji) {
      if (!emoji || emoji.length > MAX_EMOJI_LENGTH) {
        throw new Error('Invalid reaction');
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO reactions (chat_id, seq, user_id, emoji)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chat_id, seq, user_id, emoji) DO NOTHING`,
          [chatId, seq, userId, emoji]
        );
        const summary = await refreshSummary(client, chatId, seq);
        await client.query('COMMIT');
        return summary;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async remove(chatId, seq, userId, emoji) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM reactions
            WHERE chat_id = $1 AND seq = $2 AND user_id = $3 AND emoji = $4`,
          [chatId, seq, userId, emoji]
        );
        const summary = await refreshSummary(client, chatId, seq);
        await client.query('COMMIT');
        return summary;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async listFor(chatId, seq) {
      const { rows } = await this.pool.query(
        `SELECT emoji, user_id, created_at FROM reactions
          WHERE chat_id = $1 AND seq = $2
          ORDER BY created_at`,
        [chatId, seq]
      );
      return rows.map((r) => ({ emoji: r.emoji, userId: r.user_id, createdAt: r.created_at }));
    },
  };
}
