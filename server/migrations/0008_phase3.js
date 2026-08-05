// ============================================================
// 0008 — Phase 3: admin rights, invites, polls, scheduling, folders
// ============================================================
// The important part of this migration is the first section.
//
// Groups are currently joined with `chats.join_key`: a permanent, unrevocable
// bearer secret. Anyone who has ever seen it can rejoin forever, there is no
// way to withdraw it, no expiry, no usage limit, and no record of who used it.
// A member who leaves — or is removed — keeps working access indefinitely.
//
// `chat_invites` replaces it with links that can be revoked, expired, limited
// by use count, and attributed. The old column stays for one release so
// existing clients keep working; deleting it is a follow-up.
//
// Everything else here inherits the 24-hour rule. Note especially that a
// scheduled message must fire *within* the window: one scheduled for next week
// would be reaped before it was ever delivered, so the schema forbids it.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Invites ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_invites (
    hash              text PRIMARY KEY,
    chat_id           uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    usage_limit       int CHECK (usage_limit IS NULL OR usage_limit > 0),
    usage_count       int NOT NULL DEFAULT 0,
    revoked           boolean NOT NULL DEFAULT false,
    title             text
);

CREATE INDEX IF NOT EXISTS idx_chat_invites_chat ON chat_invites (chat_id);

-- Who used which invite. Without this an admin can revoke a link but has no
-- idea who it let in.
CREATE TABLE IF NOT EXISTS chat_invite_uses (
    hash    text NOT NULL REFERENCES chat_invites(hash) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (hash, user_id)
);

-- ─── Bans ───────────────────────────────────────────────────
-- Removing a member is not enough on its own: without this they simply rejoin
-- with any valid invite.

CREATE TABLE IF NOT EXISTS chat_banned (
    chat_id   uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until     timestamptz,
    banned_by uuid REFERENCES users(id) ON DELETE SET NULL,
    banned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);

-- ─── Polls ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS polls (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id         uuid NOT NULL,
    seq             bigint NOT NULL,
    question        text NOT NULL,
    options         jsonb NOT NULL,
    is_anonymous    boolean NOT NULL DEFAULT true,
    allows_multiple boolean NOT NULL DEFAULT false,
    closed_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A poll cannot outlive the message that carries it.
    FOREIGN KEY (chat_id, seq) REFERENCES messages (chat_id, seq) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_message ON polls (chat_id, seq);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id   uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_id int NOT NULL,
    voted_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, user_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes (poll_id);

-- ─── Folders ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS folders (
    id         serial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      text NOT NULL,
    emoji      text,
    position   int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id, position);

CREATE TABLE IF NOT EXISTS folder_chats (
    folder_id int NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    chat_id   uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, chat_id)
);

-- ─── Scheduling ─────────────────────────────────────────────
-- scheduled_at already exists on messages from 0002. This constraint is the
-- new part: a message scheduled beyond the retention window would be deleted
-- by the reaper before it ever fired, so the database refuses it outright
-- rather than accepting a send that can never happen.

ALTER TABLE messages
    ADD CONSTRAINT scheduled_within_retention
    CHECK (
      scheduled_at IS NULL
      OR scheduled_at <= sent_at + interval '24 hours'
    )
    NOT VALID;
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE messages DROP CONSTRAINT IF EXISTS scheduled_within_retention;

DROP TABLE IF EXISTS folder_chats;
DROP INDEX IF EXISTS idx_folders_user;
DROP TABLE IF EXISTS folders;

DROP INDEX IF EXISTS idx_poll_votes_poll;
DROP TABLE IF EXISTS poll_votes;
DROP INDEX IF EXISTS idx_polls_message;
DROP TABLE IF EXISTS polls;

DROP TABLE IF EXISTS chat_banned;
DROP TABLE IF EXISTS chat_invite_uses;
DROP INDEX IF EXISTS idx_chat_invites_chat;
DROP TABLE IF EXISTS chat_invites;
  `);
}
