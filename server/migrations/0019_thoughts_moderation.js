// ============================================================
// 0019 — Thoughts moderation
// ============================================================
// Separate from 0018 so the takedown model can change without touching the
// content DDL, and because the two answer different questions: 0018 is what a
// post *is*, this is what happens when one should not exist.
//
// **The policy is the enum.** The stated posture is that nothing is removed for
// being disagreeable — only for being illegal. If the report form offered
// "offensive" or "misinformation", the product would be promising a review it
// has said it will not perform, and the queue would fill with complaints
// nobody intends to action. Restricting the categories is what makes the
// promise honest, so it is a CHECK constraint rather than a UI convention.
//
// **The queue is inherently 24 hours long.** post_reports cascades from posts,
// which expire. The operator therefore has at most a day to act, after which
// the content is gone by itself. For illegal content that is the right shape —
// the remedy is deletion and deletion is automatic. What has to outlive the
// post is the ability to act on the *author*, which is what moderation_actions
// and posting_blocked_until are for.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS post_reports (
    id          bigserial PRIMARY KEY,
    post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    -- SET NULL rather than CASCADE: a report should survive the reporter
    -- deleting their account, or a bad actor could clear reports against them
    -- by cycling accounts.
    --
    -- (On takedown, posts.body is blanked but posts.media is kept. The fileId
    -- is not content, and phase8.repo.canViewMediaFile needs it to deny the
    -- file — see the comment on removePost.)
    reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
    category    text NOT NULL CHECK (category IN
                  ('csam', 'terrorism', 'nonconsensual_intimate',
                   'credible_threat', 'other_illegal')),
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One report per person per post. Without this, a coordinated group can
    -- manufacture the appearance of consensus by reporting repeatedly.
    UNIQUE (post_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reports_queue ON post_reports (created_at DESC);

-- Deliberately NOT subject to the 24h rule, for the same reason chat_admin_log
-- is exempt (0011_channels.js): it records *actions*, not content.
--
-- post_id is intentionally not a foreign key — the row has to outlive the post
-- it refers to, which is the entire point of keeping it.
--
-- The reason and category columns must never be used to stash a post body.
-- Doing so would smuggle user content past the retention ceiling into a table
-- nothing ever reaps. Ids and enums only.
CREATE TABLE IF NOT EXISTS moderation_actions (
    id         bigserial PRIMARY KEY,
    post_id    uuid,
    author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action     text NOT NULL CHECK (action IN
                 ('post_removed', 'posting_blocked', 'posting_unblocked')),
    category   text,
    reason     text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_author
    ON moderation_actions (author_id, created_at DESC);

-- A restriction bit. Note the asymmetry with is_operator below: a bug that
-- wrongly sets this is an outage for one account, whereas a bug that wrongly
-- sets is_operator is privilege escalation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS posting_blocked_until timestamptz;

-- Granted by hand in SQL; nothing in the application ever writes it.
--
-- Worth stating plainly, since this is a privilege bit on a table whose rows
-- anyone can create by signing up: any code path that can UPDATE users can
-- grant this. An environment variable could not be granted at runtime at all.
-- The mitigation chosen instead is that the routes reading it are narrow, they
-- 404 rather than 403 for non-operators, and the same actions are available
-- offline through scripts/moderation.js — so the HTTP surface can be removed
-- entirely without losing the capability.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_operator boolean NOT NULL DEFAULT false;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE users DROP COLUMN IF EXISTS is_operator;
ALTER TABLE users DROP COLUMN IF EXISTS posting_blocked_until;
DROP INDEX IF EXISTS idx_moderation_actions_author;
DROP TABLE IF EXISTS moderation_actions;
DROP INDEX IF EXISTS idx_post_reports_queue;
DROP TABLE IF EXISTS post_reports;
  `);
}
