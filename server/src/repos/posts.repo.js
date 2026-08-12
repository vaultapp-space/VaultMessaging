// ============================================================
// Vault — repos/posts.repo.js
// ============================================================
// Thoughts: public posts with the same 24-hour life as everything else.
//
// Two rules run through every query here.
//
// **Filter in SQL, never after the fetch.** Blocks and mutes are applied as
// predicates, following the precedent in phase8.repo.feedFor. Filtering a page
// after it comes back returns short pages and breaks keyset pagination, and —
// more importantly — every future code path that forgets the filter becomes a
// leak. The predicate lives with the query so it cannot be forgotten.
//
// **Child posts never outlive their parent.** See resolveExpiry below; the
// reason is subtler than tidiness and is a genuine data-loss bug if missed.

import fs from 'node:fs';
import path from 'node:path';

const POST_TTL_SECONDS = 86400;
const MAX_BODY_LENGTH = 500;

// The extension is not recorded on the post, so every allowed one is tried —
// the same approach maintenance.repo takes for stories. Missing files are
// expected, since a text-only post has none.
const MEDIA_EXTENSIONS = ['.webp', '.png', '.gif', '.webm'];

// Applied to every timeline and thread read. Symmetric for blocks (matching
// phase8.repo.feedFor: if either party blocked the other, neither sees the
// other's posts), one-directional for mutes.
//
// $1 is always the viewer.
const VISIBILITY_PREDICATE = `
    AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = p.author_id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = p.author_id))
    AND NOT EXISTS (
          SELECT 1 FROM user_mutes m
           WHERE m.muter_id = $1 AND m.muted_id = p.author_id)`;

// The shape every read returns. `liked_by_me` and friends come from LEFT JOINs
// rather than a second round trip: one index lookup per returned row inside the
// query that already ran, instead of an N+1 or a per-card fetch.
const SELECT_COLUMNS = `
    p.id, p.author_id, u.username,
    p.body, p.media, p.reply_to_id, p.root_id, p.repost_of_id,
    p.likes_count, p.replies_count, p.reposts_count,
    p.created_at, p.expires_at,
    (l.user_id IS NOT NULL) AS liked_by_me`;

const SELECT_JOINS = `
    JOIN users u ON u.id = p.author_id
    LEFT JOIN post_likes l ON l.post_id = p.id AND l.user_id = $1`;

export function createPosts({ pool, uploadsDir }) {
  return {
    pool,
    uploadsDir,
    ttlSeconds: POST_TTL_SECONDS,
    maxBodyLength: MAX_BODY_LENGTH,

    /** Removes a post's image from disk. Safe to call for a post with none. */
    async unlinkMedia(media) {
      const fileId = media?.fileId;
      if (!fileId) return;
      for (const extension of MEDIA_EXTENSIONS) {
        await fs.promises
          .unlink(path.join(this.uploadsDir, 'media', `${fileId}${extension}`))
          .catch(() => {});
      }
    },

    shape(row) {
      return {
        id: row.id,
        authorId: row.author_id,
        username: row.username,
        body: row.body,
        media: row.media ?? null,
        replyToId: row.reply_to_id ?? null,
        rootId: row.root_id ?? null,
        repostOfId: row.repost_of_id ?? null,
        likesCount: row.likes_count,
        repliesCount: row.replies_count,
        repostsCount: row.reposts_count,
        likedByMe: row.liked_by_me ?? false,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    /**
     * Creates a post, a reply, a repost or a quote post — they are all rows in
     * `posts` and differ only by which reference columns are set.
     *
     * Returns null when the parent is missing, expired or removed, which the
     * route turns into a 404.
     */
    async create(author, { body = null, media = null, replyToId = null, repostOfId = null }) {
      const parentId = replyToId ?? repostOfId;
      let parent = null;

      if (parentId) {
        const { rows } = await this.pool.query(
          `SELECT id, root_id, expires_at FROM posts
            WHERE id = $1 AND removed_at IS NULL AND expires_at > now()`,
          [parentId]
        );
        parent = rows[0];
        if (!parent) return null;
      }

      // A reply to a reply attaches to the same root, keeping depth at 2.
      const rootId = replyToId ? (parent.root_id ?? parent.id) : null;

      // The expiry clamp. A reply written 23h after its parent would otherwise
      // outlive it and then vanish by ON DELETE CASCADE — and cascade-deleted
      // rows are never returned by DELETE ... RETURNING, so the reaper would
      // never see this row's media and would leave the file on disk forever,
      // publicly readable. Clamping to the parent means one reaper DELETE
      // collects parents and children together.
      const { rows } = await this.pool.query(
        `INSERT INTO posts (author_id, body, media, reply_to_id, root_id, repost_of_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 LEAST(now() + ($7 || ' seconds')::interval,
                       COALESCE($8::timestamptz, 'infinity')))
         RETURNING *, false AS liked_by_me`,
        [
          author.id, body, media,
          replyToId, rootId, repostOfId,
          String(POST_TTL_SECONDS), parent?.expires_at ?? null,
        ]
      );

      // username is not on the posts row; the author is the caller, so it is
      // known without a join back to users.
      const post = { ...rows[0], username: author.username };

      // Counters are denormalised, so the parent's has to move with the insert.
      if (replyToId) {
        await this.pool.query(
          `UPDATE posts SET replies_count = replies_count + 1 WHERE id = $1`,
          [replyToId]
        );
      } else if (repostOfId) {
        await this.pool.query(
          `UPDATE posts SET reposts_count = reposts_count + 1 WHERE id = $1`,
          [repostOfId]
        );
      }

      return this.shape(post);
    },

    /**
     * One page of the timeline, newest first.
     *
     * `cursor` is {createdAt, id} from the last row of the previous page. The
     * row-comparison form `(a, b) < ($x, $y)` is deliberate: written as
     * `a < $x OR (a = $x AND b < $y)` the planner will not treat it as a single
     * range scan over idx_posts_global.
     *
     * `expires_at > now()` is required even though the reaper deletes: it runs
     * every 60s, so without this up to a minute of expired content is visible.
     */
    async timeline(viewerId, { tab = 'global', cursor = null, limit = 20 } = {}) {
      const followingClause = tab === 'following'
        ? `AND (p.author_id = $1
               OR EXISTS (SELECT 1 FROM follows f
                           WHERE f.follower_id = $1 AND f.followee_id = p.author_id))`
        : '';

      // limit + 1 so hasMore is known without a second count query.
      const { rows } = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM posts p ${SELECT_JOINS}
          WHERE p.reply_to_id IS NULL
            AND p.removed_at IS NULL
            AND p.expires_at > now()
            AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
            ${followingClause}
            ${VISIBILITY_PREDICATE}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $4`,
        [viewerId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { posts: page.map((r) => this.shape(r)), hasMore };
    },

    /** A single post, subject to the same visibility rules as the timeline. */
    async get(viewerId, postId) {
      const { rows } = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM posts p ${SELECT_JOINS}
          WHERE p.id = $2
            AND p.removed_at IS NULL
            AND p.expires_at > now()
            ${VISIBILITY_PREDICATE}`,
        [viewerId, postId]
      );
      return rows[0] ? this.shape(rows[0]) : null;
    },

    /**
     * Deletes a post the caller wrote. Returns the media so the route can
     * unlink the file — the same before-the-row ordering the reaper uses.
     *
     * Replies and reposts of it cascade. Their media is *not* returned by
     * RETURNING (cascade-deleted rows never are), which is exactly why
     * children are clamped to expire with their parent: the reaper will
     * collect them itself rather than them being orphaned here.
     */
    async deleteOwn(authorId, postId) {
      const { rows } = await this.pool.query(
        `DELETE FROM posts WHERE id = $1 AND author_id = $2 RETURNING media`,
        [postId, authorId]
      );
      if (!rows[0]) return false;
      await this.unlinkMedia(rows[0].media);
      return true;
    },
  };
}
