// ============================================================
// 0023 — an index for a profile's replies
// ============================================================
// v1.32 added a Replies view to profiles, and it queries the exact shape the
// existing author index excludes.
//
// idx_posts_author is partial: WHERE reply_to_id IS NULL AND removed_at IS
// NULL. That is right for what it was built for — the timeline and the Posts
// view, neither of which ever wants a reply — but it means the Replies view
// has nothing to use and falls back to scanning.
//
// Free today, because the table never holds more than 24 hours of posts and
// the planner correctly prefers a scan at that size. It is here because the
// query exists now and the index is the cheap half of the pair: an index that
// is never chosen costs one write per insert, while a missing one costs a scan
// per read forever after the table grows past the crossover.
//
// The predicate mirrors the query in posts.repo.byAuthor exactly. A partial
// index whose WHERE does not match the query's is simply never used, which is
// the quiet way this kind of change achieves nothing.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE INDEX IF NOT EXISTS idx_posts_author_replies
    ON posts (author_id, created_at DESC, id DESC)
    WHERE reply_to_id IS NOT NULL AND removed_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_posts_author_replies;
  `);
}
