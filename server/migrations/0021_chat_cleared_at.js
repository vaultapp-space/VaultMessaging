// ============================================================
// 0021 — deleting a chat, for one side only
// ============================================================
// There was no way to remove a conversation from your own list. Archiving
// hides it; nothing cleared it.
//
// **This deletes for the person who asked, and only for them.** The column
// lives on `chat_settings`, which is already the per-user view of a shared
// chat (mute, archive, pin, theme all live there), so a clear cannot reach
// the other participant's copy by construction. That is the conservative
// reading of "delete this chat", and it is the only one that is safe to get
// wrong: hiding too little is an annoyance, while deleting someone else's
// history on their behalf is unrecoverable.
//
// It also matters that this is not a `DELETE FROM chat_members`. Dropping
// membership would look equivalent and would break the conversation — the
// other participant could no longer deliver to a chat you are not in, so
// "delete" would silently become "block", and re-adding you on their next
// message is a race nobody should have to reason about. Membership is what
// makes the chat work; `cleared_at` is only what you see.
//
// The chat comes back when there is something new in it: the list hides a
// cleared chat only while `last_message_at <= cleared_at`. A conversation
// that resumes should reappear, or a deleted chat becomes an accidental,
// silent block on someone you have not blocked.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
ALTER TABLE chat_settings
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

COMMENT ON COLUMN chat_settings.cleared_at IS
  'Per-user clear point. Messages at or before this are hidden from this user, and the chat is hidden from their list until something newer arrives. Never affects the other participant.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
ALTER TABLE chat_settings DROP COLUMN IF EXISTS cleared_at;
  `);
}
