// ============================================================
// 0003 — Backfill existing conversations into the chat model
// ============================================================
// Turns implied conversations into real `chats` rows.
//
// Two sources:
//   1. every row in `groups`            → a group chat
//   2. every distinct sender/recipient  → a private chat
//      pair in `messages`
//
// Both are created with mode='secret', because everything that exists today
// is end-to-end encrypted and must keep being treated that way. Only chats
// created after this migration default to cloud.
//
// Group chats deliberately **reuse the group's own id as the chat id**. The
// client addresses groups as `group-<uuid>` in several places; keeping the id
// stable means those references still resolve during the transition instead
// of every client losing its groups at once.
//
// Private chat ids are derived deterministically from the participant pair,
// so both sides compute the same id with no lookup and no race over who
// sends first.
//
// The message half of this backfill is shallow by construction: retention is
// capped at 24 hours, so `messages` is never more than a day deep. The half
// that must be exact is `chats` and `chat_members` — those rows are durable,
// and losing them loses conversations and group membership, which users
// notice far more than losing yesterday's text.

export const shorthands = undefined;

// Fixed namespace for deterministic private chat ids. Never change this: it
// would repartition every existing private conversation.
const CHAT_NAMESPACE = 'b7f4a3c2-8e1d-4f6a-9b2c-5d3e7a1f8c04';

export async function up(pgm) {
  pgm.sql(`
-- ─── Groups → group chats (id preserved) ────────────────────

INSERT INTO chats (id, type, mode, title, join_key, created_by, created_at, members_count)
SELECT g.id,
       'group'::chat_type,
       'secret'::chat_mode,
       g.name,
       g.join_key,
       g.created_by,
       COALESCE(g.created_at, now()),
       (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id)
  FROM groups g
 ON CONFLICT (id) DO NOTHING;

INSERT INTO chat_members (chat_id, user_id, role, joined_at)
SELECT gm.group_id,
       gm.user_id,
       CASE WHEN g.created_by = gm.user_id THEN 'owner' ELSE 'member' END,
       COALESCE(g.created_at, now())
  FROM group_members gm
  JOIN groups g ON g.id = gm.group_id
 ON CONFLICT (chat_id, user_id) DO NOTHING;

-- ─── Message pairs → private chats (deterministic ids) ──────

WITH pairs AS (
    SELECT DISTINCT
           LEAST(sender_id, recipient_id)    AS a,
           GREATEST(sender_id, recipient_id) AS b
      FROM messages
     WHERE recipient_id IS NOT NULL
       AND sender_id <> recipient_id
       AND group_id IS NULL
)
INSERT INTO chats (id, type, mode, created_at)
SELECT uuid_generate_v5('${CHAT_NAMESPACE}'::uuid, a::text || b::text),
       'private'::chat_type,
       'secret'::chat_mode,
       now()
  FROM pairs
 ON CONFLICT (id) DO NOTHING;

WITH pairs AS (
    SELECT DISTINCT
           LEAST(sender_id, recipient_id)    AS a,
           GREATEST(sender_id, recipient_id) AS b
      FROM messages
     WHERE recipient_id IS NOT NULL
       AND sender_id <> recipient_id
       AND group_id IS NULL
), chat_pairs AS (
    SELECT uuid_generate_v5('${CHAT_NAMESPACE}'::uuid, a::text || b::text) AS chat_id, a, b
      FROM pairs
)
INSERT INTO chat_members (chat_id, user_id, role)
SELECT chat_id, a, 'member' FROM chat_pairs
UNION ALL
SELECT chat_id, b, 'member' FROM chat_pairs
 ON CONFLICT (chat_id, user_id) DO NOTHING;

-- ─── Attach messages to their chat ──────────────────────────

-- Group messages: group_id is a text column holding either the bare uuid or
-- the client's 'group-<uuid>' form, so strip the prefix before casting.
UPDATE messages m
   SET chat_id = c.id
  FROM chats c
 WHERE m.chat_id IS NULL
   AND m.group_id IS NOT NULL
   AND c.id = NULLIF(regexp_replace(m.group_id, '^group-', ''), '')::uuid;

UPDATE messages m
   SET chat_id = uuid_generate_v5(
         '${CHAT_NAMESPACE}'::uuid,
         LEAST(m.sender_id, m.recipient_id)::text || GREATEST(m.sender_id, m.recipient_id)::text
       )
 WHERE m.chat_id IS NULL
   AND m.group_id IS NULL
   AND m.recipient_id IS NOT NULL
   AND m.sender_id <> m.recipient_id;

-- ─── Assign per-chat sequence numbers ───────────────────────
-- Ordered by send time, with id as a tiebreaker so the result is stable if
-- the migration is ever re-run against the same data.

WITH numbered AS (
    SELECT id,
           row_number() OVER (PARTITION BY chat_id ORDER BY sent_at, id) AS rn
      FROM messages
     WHERE chat_id IS NOT NULL AND seq IS NULL
)
UPDATE messages m
   SET seq = n.rn
  FROM numbered n
 WHERE m.id = n.id;

-- ─── Chat counters ──────────────────────────────────────────

UPDATE chats c
   SET last_seq = COALESCE(agg.max_seq, 0),
       last_message_at = agg.last_at
  FROM (
        SELECT chat_id, max(seq) AS max_seq, max(sent_at) AS last_at
          FROM messages
         WHERE chat_id IS NOT NULL
         GROUP BY chat_id
       ) agg
 WHERE c.id = agg.chat_id;

UPDATE chats c
   SET members_count = (SELECT count(*) FROM chat_members cm WHERE cm.chat_id = c.id);

-- ─── Read state ─────────────────────────────────────────────
-- Seeded from the per-message read flag this replaces, so existing unread
-- badges do not all reset to zero on deploy.

INSERT INTO chat_read_state (chat_id, user_id, read_inbox_max_seq, unread_count)
SELECT m.chat_id,
       cm.user_id,
       COALESCE(max(m.seq) FILTER (WHERE m.read AND m.recipient_id = cm.user_id), 0),
       count(*) FILTER (WHERE NOT m.read AND m.recipient_id = cm.user_id)::int
  FROM messages m
  JOIN chat_members cm ON cm.chat_id = m.chat_id
 WHERE m.chat_id IS NOT NULL
 GROUP BY m.chat_id, cm.user_id
 ON CONFLICT (chat_id, user_id) DO NOTHING;
  `);
}

export async function down(pgm) {
  // Detach messages and drop the derived rows. The source tables (groups,
  // group_members, messages) are untouched by this migration, so reverting
  // loses nothing that was not derived here.
  pgm.sql(`
UPDATE messages SET chat_id = NULL, seq = NULL;
DELETE FROM chat_read_state;
DELETE FROM chat_members;
DELETE FROM chats;
  `);
}
