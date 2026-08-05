// ============================================================
// 0014 — Phase 8: voice chats, forum topics, stories
// ============================================================
// The long tail. Three unrelated features that share one migration because
// each is small on its own.
//
// **Voice chats.** This is the room and participant model — who is in a call,
// who is muted, who is speaking. The *media* plane is deliberately not here:
// `client/src/lib/webrtc.js` is a 1:1 mesh and will not scale past roughly
// four participants, and doing better means running an SFU (mediasoup or
// LiveKit), which is new infrastructure rather than new code. So voice chats
// ship with a hard participant cap and the schema is ready for an SFU to be
// dropped in behind it. Overstating this would be worse than the cap: a call
// that degrades badly at eight people is a worse experience than one that
// says it holds four.
//
// **Forum topics.** Almost free. `chats.is_forum` exists from 0002 and
// `messages.thread_root_seq` from 0002 as well; this adds the topic list.
//
// **Stories.** Ironically the cheapest thing in the plan, because the whole
// product is already built around 24-hour expiry — a story is media with a
// TTL and a viewer list, and both already exist. `expires_at` is NOT NULL
// here for the same reason it is everywhere else.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Voice chats ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS voice_chats (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title      text,
    started_by uuid REFERENCES users(id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at   timestamptz
);

-- One live call per chat. A partial unique index rather than a constraint,
-- because ended calls must be allowed to pile up while only one may be open.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_chats_live
    ON voice_chats (chat_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS voice_chat_participants (
    voice_chat_id uuid NOT NULL REFERENCES voice_chats(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at     timestamptz NOT NULL DEFAULT now(),
    left_at       timestamptz,
    is_muted      boolean NOT NULL DEFAULT false,
    -- Set by a moderator; distinct from is_muted, which the participant
    -- controls themselves. Collapsing the two would let someone un-mute
    -- themselves after being muted by an admin.
    muted_by_admin boolean NOT NULL DEFAULT false,
    is_speaking   boolean NOT NULL DEFAULT false,
    PRIMARY KEY (voice_chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_participants_live
    ON voice_chat_participants (voice_chat_id) WHERE left_at IS NULL;

-- ─── Forum topics ───────────────────────────────────────────
-- A topic is a named thread root inside a group. Messages already carry
-- thread_root_seq from 0002, so this is only the list of topics themselves.

CREATE TABLE IF NOT EXISTS forum_topics (
    chat_id     uuid   NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    topic_id    bigserial,
    title       text   NOT NULL,
    icon_emoji  text,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    closed_at   timestamptz,
    is_pinned   boolean NOT NULL DEFAULT false,
    -- The seq messages in this topic hang off. Nullable until the first
    -- message: a topic can exist before anyone has posted in it.
    root_seq    bigint,
    PRIMARY KEY (chat_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_forum_topics_chat
    ON forum_topics (chat_id, is_pinned DESC, created_at DESC);

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS topic_id bigint;

CREATE INDEX IF NOT EXISTS idx_messages_topic
    ON messages (chat_id, topic_id, seq) WHERE topic_id IS NOT NULL;

-- ─── Stories ────────────────────────────────────────────────
-- Media on a profile that expires. The reaper already does the work; this is
-- the only new storage.

CREATE TABLE IF NOT EXISTS stories (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media      jsonb NOT NULL,
    caption    text,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- NOT NULL, and clamped by the repo. A story is content like any other
    -- and is not exempt from the ceiling.
    expires_at timestamptz NOT NULL,
    -- Who may see it. 'contacts' means people this user has added.
    privacy    text NOT NULL DEFAULT 'contacts'
                 CHECK (privacy IN ('everyone', 'contacts', 'nobody'))
);

CREATE INDEX IF NOT EXISTS idx_stories_user ON stories (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories (expires_at);

-- Who has seen a story. Cascades with it, so the viewer list cannot outlive
-- the story — which would leave a record of who looked at something that no
-- longer exists.
CREATE TABLE IF NOT EXISTS story_views (
    story_id  uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (story_id, user_id)
);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP TABLE IF EXISTS story_views;
DROP INDEX IF EXISTS idx_stories_expiry;
DROP INDEX IF EXISTS idx_stories_user;
DROP TABLE IF EXISTS stories;

DROP INDEX IF EXISTS idx_messages_topic;
ALTER TABLE messages DROP COLUMN IF EXISTS topic_id;
DROP INDEX IF EXISTS idx_forum_topics_chat;
DROP TABLE IF EXISTS forum_topics;

DROP INDEX IF EXISTS idx_voice_participants_live;
DROP TABLE IF EXISTS voice_chat_participants;
DROP INDEX IF EXISTS idx_voice_chats_live;
DROP TABLE IF EXISTS voice_chats;
  `);
}
