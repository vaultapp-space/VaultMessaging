// ============================================================
// Vault — repos/maintenance.repo.js
// ============================================================
// The reaper. Deletes anything past its expiry across messages and
// attachments, including the on-disk chunks.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.

import fs from 'node:fs';
import path from 'node:path';

export function createMaintenance({ pool, uploadsDir }) {
  return {
    pool,
    uploadsDir,

  async reap() {
    const now = new Date().toISOString();
    
    // Delete expired attachments from disk
    const expiredAttachments = await this.pool.query(
      `SELECT id, total_chunks FROM files WHERE expires_at < $1`,
      [now]
    );

    for (const row of expiredAttachments.rows) {
      for (let i = 0; i < row.total_chunks; i++) {
        const filePath = path.join(this.uploadsDir, `${row.id}_${i}.txt`);
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }

    // Delete records from DB
    await this.pool.query(`DELETE FROM files WHERE expires_at < $1`, [now]);

    // Delete expired messages
    const expiredMsgs = await this.pool.query(
      `DELETE FROM messages WHERE expires_at < $1 RETURNING id`,
      [now]
    );

    // The update log holds copies of message bodies for offline devices to
    // replay. Reaping it here rather than in its own job is deliberate: if
    // the two ever ran on different schedules, the log would briefly — and
    // then permanently, on any failure — be an archive of messages that had
    // already been deleted everywhere else.
    await this.pool.query(`DELETE FROM user_updates WHERE expires_at < $1`, [now]);

    // Stories are media with a TTL, so they go the same way. Their view rows
    // cascade, which matters: a viewer list outliving its story would be a
    // record of who looked at something that no longer exists.
    //
    // The image on disk has to go with them. A story's file is uploaded
    // through the public media path — which is deliberately *not* the
    // expiring attachment path, because a story is shown to an audience
    // rather than encrypted to a recipient — so nothing else would ever
    // delete it. Left alone it would be a permanent copy of content the
    // database has already forgotten, reachable by anyone who kept the URL.
    const expiredStories = await this.pool.query(
      `DELETE FROM stories WHERE expires_at < $1 RETURNING media`, [now]
    );
    for (const row of expiredStories.rows) {
      const fileId = row.media?.fileId;
      if (!fileId) continue;
      // The extension is not recorded on the story, so every allowed one is
      // tried. Missing files are expected — a text-only story has none.
      for (const extension of ['.webp', '.png', '.gif', '.webm']) {
        await fs.promises
          .unlink(path.join(this.uploadsDir, 'media', `${fileId}${extension}`))
          .catch(() => {});
      }
    }

    // Posts go the same way as stories, and for the same reason: their image
    // is uploaded through the public media path, so nothing else would ever
    // delete it.
    //
    // Batched. /health returns 503 if no reaper pass succeeds for 15 minutes,
    // and a public feed can accumulate a lot of rows during an outage. An
    // unbounded delete could turn one catch-up pass into a long transaction
    // and take the instance out of the load balancer for something that is
    // not an outage. The 60s cadence catches up over a few passes instead.
    //
    // Replies and reposts are clamped at insert to expire no later than what
    // they answer (posts.repo.create), so they are collected by this same
    // statement rather than cascading — which matters, because a cascaded
    // delete is never seen by RETURNING and its media would be left on disk.
    const expiredPosts = await this.pool.query(
      `DELETE FROM posts
        WHERE id IN (SELECT id FROM posts WHERE expires_at < $1 LIMIT 5000)
        RETURNING media`,
      [now]
    );
    for (const row of expiredPosts.rows) {
      const fileId = row.media?.fileId;
      if (!fileId) continue;
      for (const extension of ['.webp', '.png', '.gif', '.webm']) {
        await fs.promises
          .unlink(path.join(this.uploadsDir, 'media', `${fileId}${extension}`))
          .catch(() => {});
      }
    }

    // Deliberately not adding expiredPosts to this. The caller uses the return
    // value to decide whether to run chats.reconcileUnread(), and posts have
    // no bearing on chat unread counters — folding them in would trigger a
    // full recalculation every 60s for as long as the feed is active.
    return expiredMsgs.rowCount;
  },
  };
}
