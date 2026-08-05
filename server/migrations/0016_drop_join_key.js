// ============================================================
// 0016 — Drop the legacy join key
// ============================================================
// `join_key` was a **permanent, unrevocable bearer secret**. Anyone who had
// ever seen one could rejoin that group forever: no expiry, no usage limit,
// no revocation, and no record of who used it. A member who left — or was
// removed, or was banned — kept working access indefinitely, because the
// secret they held was still valid.
//
// `chat_invites` (0008) replaced it with links that expire, can be limited by
// use count, can be revoked, and record who redeemed them. The column was
// kept for one release so clients that predated invites kept working. That
// release has passed.
//
// This is the migration that actually closes the hole. While the column
// existed the old path was still live, so any key ever leaked was still a
// working credential. Dropping the column is what makes the replacement mean
// something.
//
// Irreversible in the sense that matters: `down` recreates the column, but
// the keys themselves are gone, and that is correct — restoring live bearer
// secrets from a rollback would be worse than the rollback failing.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
ALTER TABLE chats  DROP COLUMN IF EXISTS join_key;
ALTER TABLE groups DROP COLUMN IF EXISTS join_key;
  `);
}

export async function down(pgm) {
  pgm.sql(`
-- Recreated empty. The old keys are not restored: a rollback must not bring
-- unrevocable credentials back to life.
ALTER TABLE chats  ADD COLUMN IF NOT EXISTS join_key text;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS join_key text;
  `);
}
