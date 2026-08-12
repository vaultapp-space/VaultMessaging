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

// How many posts by one author may appear in a single page of the global
// timeline, and how far the query looks to fill that page around them.
const MAX_PER_AUTHOR_PER_PAGE = 2;
const WINDOW_MULTIPLIER = 5;

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
      const following = tab === 'following';
      const followingClause = following
        ? `AND (p.author_id = $1
               OR EXISTS (SELECT 1 FROM follows f
                           WHERE f.follower_id = $1 AND f.followee_id = p.author_id))`
        : '';

      const base = `
            FROM posts p ${SELECT_JOINS}
           WHERE p.reply_to_id IS NULL
             AND p.removed_at IS NULL
             AND p.expires_at > now()
             AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
             ${followingClause}
             ${VISIBILITY_PREDICATE}`;

      // The Following tab is self-curated — if you follow someone who posts a
      // lot, seeing all of it is the point — so it pages straight through.
      //
      // The global tab caps each author to MAX_PER_AUTHOR_PER_PAGE within the
      // window it scans. It is the cheapest effective spam control available:
      // without it one account posting in a loop owns the whole feed, and no
      // rate limit low enough to prevent that is high enough for real use.
      //
      // Be clear about the cost, because it is not only cosmetic: the capped
      // posts are not deferred to a later page, they are **dropped**. Paging
      // to the end of the global tab will not show everything a prolific
      // author wrote. That makes Global a *sampled* view — a discovery
      // surface — and Following the complete one. If that trade ever stops
      // being worth it, raising MAX_PER_AUTHOR_PER_PAGE is the dial; removing
      // the cap hands the feed to whoever posts most.
      //
      // A capped page is also allowed to come back shorter than `limit`; the
      // client must page on `hasMore`, never on `posts.length === limit`.
      if (!following) {
        const windowSize = limit * WINDOW_MULTIPLIER;
        const { rows } = await this.pool.query(
          `WITH candidates AS (
             SELECT ${SELECT_COLUMNS},
                    row_number() OVER (PARTITION BY p.author_id
                                       ORDER BY p.created_at DESC, p.id DESC) AS rn
             ${base}
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT $4
           )
           SELECT *, (SELECT count(*) FROM candidates) AS window_count
             FROM candidates
            WHERE rn <= ${MAX_PER_AUTHOR_PER_PAGE}
            ORDER BY created_at DESC, id DESC
            LIMIT $5`,
          [viewerId, cursor?.createdAt ?? null, cursor?.id ?? null, windowSize, limit + 1]
        );

        // Two separate reasons there may be more: the capped set overflowed
        // this page, or the window itself was full so candidates exist beyond
        // it. Missing the second would end pagination early and silently hide
        // the rest of the feed.
        const windowFull = rows.length > 0 && Number(rows[0].window_count) === windowSize;
        const hasMore = rows.length > limit || windowFull;
        const page = rows.slice(0, limit);
        return { posts: page.map((r) => this.shape(r)), hasMore };
      }

      // limit + 1 so hasMore is known without a second count query.
      const { rows } = await this.pool.query(
        `SELECT ${SELECT_COLUMNS} ${base}
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

    // ─── Threads and profiles ─────────────────────────────

    /**
     * The replies under a top-level post, oldest first — a conversation reads
     * downward, unlike the timeline.
     *
     * Blocks and mutes apply here too. Without that, blocking is defeated by
     * anyone replying to a post the blocked user can already see.
     */
    async replies(viewerId, rootId, { cursor = null, limit = 50 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM posts p ${SELECT_JOINS}
          WHERE p.root_id = $2
            AND p.removed_at IS NULL
            AND p.expires_at > now()
            AND ($3::timestamptz IS NULL OR (p.created_at, p.id) > ($3::timestamptz, $4::uuid))
            ${VISIBILITY_PREDICATE}
          ORDER BY p.created_at ASC, p.id ASC
          LIMIT $5`,
        [viewerId, rootId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { posts: page.map((r) => this.shape(r)), hasMore };
    },

    /** A user's own top-level posts, newest first. */
    async byAuthor(viewerId, username, { cursor = null, limit = 20 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT ${SELECT_COLUMNS}
           FROM posts p ${SELECT_JOINS}
          WHERE u.username = $2
            AND p.reply_to_id IS NULL
            AND p.removed_at IS NULL
            AND p.expires_at > now()
            AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
            ${VISIBILITY_PREDICATE}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $5`,
        [viewerId, username, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { posts: page.map((r) => this.shape(r)), hasMore };
    },

    /**
     * The header of a profile. Returns null for an unknown username, and for
     * one the viewer is blocked by or has blocked — a profile that renders for
     * someone you blocked is a hole in the block.
     */
    async profile(viewerId, username) {
      const { rows } = await this.pool.query(
        `SELECT u.id, u.username,
                (SELECT count(*) FROM follows f WHERE f.followee_id = u.id) AS followers_count,
                (SELECT count(*) FROM follows f WHERE f.follower_id = u.id) AS following_count,
                EXISTS (SELECT 1 FROM follows f
                         WHERE f.follower_id = $1 AND f.followee_id = u.id) AS following,
                EXISTS (SELECT 1 FROM user_mutes m
                         WHERE m.muter_id = $1 AND m.muted_id = u.id) AS muted
           FROM users u
          WHERE u.username = $2
            AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = u.id AND b.blocked_id = $1)
                      OR (b.blocker_id = $1 AND b.blocked_id = u.id))`,
        [viewerId, username]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        username: row.username,
        followersCount: Number(row.followers_count),
        followingCount: Number(row.following_count),
        following: row.following,
        muted: row.muted,
      };
    },

    // ─── Likes ────────────────────────────────────────────

    /**
     * Like and unlike, each as a single statement.
     *
     * The membership row and the denormalised counter must agree — a filled
     * heart next to a count that disagrees is the bug users notice first. Doing
     * it in one statement with a CTE means there is no window between the two
     * writes and a double-tap cannot double-count: ON CONFLICT DO NOTHING makes
     * the second insert return no rows, so the counter moves by zero.
     *
     * Returns null when the post is gone, which the route turns into a 404.
     */
    async like(postId, userId) {
      const { rows } = await this.pool.query(
        `WITH ins AS (
           INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING 1
         )
         UPDATE posts
            SET likes_count = likes_count + (SELECT count(*) FROM ins)
          WHERE id = $1 AND removed_at IS NULL AND expires_at > now()
          RETURNING likes_count`,
        [postId, userId]
      );
      return rows[0] ? Number(rows[0].likes_count) : null;
    },

    async unlike(postId, userId) {
      const { rows } = await this.pool.query(
        `WITH del AS (
           DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2
           RETURNING 1
         )
         UPDATE posts
            SET likes_count = GREATEST(0, likes_count - (SELECT count(*) FROM del))
          WHERE id = $1 AND removed_at IS NULL AND expires_at > now()
          RETURNING likes_count`,
        [postId, userId]
      );
      return rows[0] ? Number(rows[0].likes_count) : null;
    },

    // ─── Follows and mutes ────────────────────────────────

    /** Idempotent. Returns false if the target does not exist. */
    async follow(followerId, followeeId) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO follows (follower_id, followee_id)
         SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
         ON CONFLICT DO NOTHING`,
        [followerId, followeeId]
      );
      // rowCount 0 means either already following or no such user; the caller
      // cannot tell them apart and does not need to.
      if (rowCount === 0) {
        const { rows } = await this.pool.query('SELECT 1 FROM users WHERE id = $1', [followeeId]);
        return rows.length > 0;
      }
      return true;
    },

    async unfollow(followerId, followeeId) {
      await this.pool.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2',
        [followerId, followeeId]
      );
    },

    async mute(muterId, mutedId) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO user_mutes (muter_id, muted_id)
         SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
         ON CONFLICT DO NOTHING`,
        [muterId, mutedId]
      );
      if (rowCount === 0) {
        const { rows } = await this.pool.query('SELECT 1 FROM users WHERE id = $1', [mutedId]);
        return rows.length > 0;
      }
      return true;
    },

    async unmute(muterId, mutedId) {
      await this.pool.query(
        'DELETE FROM user_mutes WHERE muter_id = $1 AND muted_id = $2',
        [muterId, mutedId]
      );
    },

    async listMutes(muterId) {
      const { rows } = await this.pool.query(
        `SELECT u.id, u.username FROM user_mutes m
           JOIN users u ON u.id = m.muted_id
          WHERE m.muter_id = $1
          ORDER BY m.created_at DESC`,
        [muterId]
      );
      return rows.map((r) => ({ id: r.id, username: r.username }));
    },

    // ─── Moderation ───────────────────────────────────────

    /** Whether this account is currently barred from posting. */
    async isPostingBlocked(userId) {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM users
          WHERE id = $1 AND posting_blocked_until IS NOT NULL
            AND posting_blocked_until > now()`,
        [userId]
      );
      return rows.length > 0;
    },

    async isOperator(userId) {
      const { rows } = await this.pool.query(
        'SELECT 1 FROM users WHERE id = $1 AND is_operator', [userId]
      );
      return rows.length > 0;
    },

    /** Idempotent per (post, reporter) — the UNIQUE constraint does the work. */
    async report(postId, reporterId, { category, note = null }) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO post_reports (post_id, reporter_id, category, note)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [postId, reporterId, category, note]
      );
      return rowCount > 0;
    },

    /**
     * The queue. Grouped by post so ten reports on one thing is one row to
     * read, not ten — the operator's time is the scarce resource here.
     */
    async reportQueue({ limit = 50 } = {}) {
      const { rows } = await this.pool.query(
        `SELECT r.post_id,
                count(*)::int AS report_count,
                array_agg(DISTINCT r.category) AS categories,
                max(r.created_at) AS last_reported_at,
                p.author_id, u.username, p.body, p.media,
                p.created_at, p.expires_at, p.removed_at
           FROM post_reports r
           JOIN posts p ON p.id = r.post_id
           JOIN users u ON u.id = p.author_id
          WHERE p.removed_at IS NULL
          GROUP BY r.post_id, p.author_id, u.username, p.body, p.media,
                   p.created_at, p.expires_at, p.removed_at
          ORDER BY max(r.created_at) DESC
          LIMIT $1`,
        [limit]
      );
      return rows.map((r) => ({
        postId: r.post_id,
        reportCount: r.report_count,
        categories: r.categories,
        lastReportedAt: r.last_reported_at,
        authorId: r.author_id,
        username: r.username,
        body: r.body,
        media: r.media ?? null,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }));
    },

    /**
     * Operator takedown. A content-free tombstone rather than a delete, so the
     * reports resolve against something and the action is auditable for the
     * day the row has left.
     *
     * Order matters and is the same as the reaper's: the file goes **first**.
     * Illegal content has to stop being served now, not at the next reaper
     * pass, and not only if the database write succeeds.
     */
    async removePost(postId, operatorId, { category = null, reason = null } = {}) {
      const { rows } = await this.pool.query(
        'SELECT author_id, media FROM posts WHERE id = $1 AND removed_at IS NULL',
        [postId]
      );
      const target = rows[0];
      if (!target) return null;

      await this.unlinkMedia(target.media);

      // The text goes; the media *reference* deliberately stays.
      //
      // Blanking `media` too was the obvious first version and it silently
      // broke the thing it was meant to help: canViewMediaFile denies a file
      // by looking for a removed post that claims it, and with the fileId gone
      // there was nothing left to match on — so the authorization backstop
      // never fired and a file that survived the unlink was still served.
      //
      // A fileId on a tombstone is not content. The row is excluded from every
      // read path by `removed_at IS NOT NULL`, so nothing renders it; the only
      // thing that reads it is the deny rule.
      await this.pool.query(
        `UPDATE posts SET body = NULL, removed_at = now() WHERE id = $1`,
        [postId]
      );

      await this.pool.query(
        `INSERT INTO moderation_actions
           (post_id, author_id, operator_id, action, category, reason)
         VALUES ($1, $2, $3, 'post_removed', $4, $5)`,
        [postId, target.author_id, operatorId, category, reason]
      );

      return { authorId: target.author_id };
    },

    /** Bars an account from posting for a period. Reversible with days = 0. */
    async setPostingBlock(userId, operatorId, { days, reason = null }) {
      const until = days > 0 ? `now() + ($2 || ' days')::interval` : 'NULL';
      const params = days > 0 ? [userId, String(days)] : [userId];

      const { rowCount } = await this.pool.query(
        `UPDATE users SET posting_blocked_until = ${until} WHERE id = $1`,
        params
      );
      if (rowCount === 0) return false;

      await this.pool.query(
        `INSERT INTO moderation_actions (author_id, operator_id, action, reason)
         VALUES ($1, $2, $3, $4)`,
        [userId, operatorId, days > 0 ? 'posting_blocked' : 'posting_unblocked', reason]
      );
      return true;
    },

    /**
     * Followers or following, paginated by created_at.
     * `direction` is 'followers' (who follows this user) or 'following'.
     *
     * The column names are interpolated, which is safe only because both come
     * from the ternary below and never from the caller's string — the route
     * additionally constrains `direction` to an enum.
     */
    async listFollows(userId, direction, { limit = 50, offset = 0 } = {}) {
      const [self, other] = direction === 'followers'
        ? ['followee_id', 'follower_id']
        : ['follower_id', 'followee_id'];

      const { rows } = await this.pool.query(
        `SELECT u.id, u.username FROM follows f
           JOIN users u ON u.id = f.${other}
          WHERE f.${self} = $1
          ORDER BY f.created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      return rows.map((r) => ({ id: r.id, username: r.username }));
    },
  };
}
