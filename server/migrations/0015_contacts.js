// ============================================================
// 0015 — Contacts
// ============================================================
// A Phase 2 leftover, and it lands here rather than being folded into 0014
// because 0014 was already applied. **Never edit an applied migration**: an
// environment that has run it will not run it again, so the change reaches
// fresh databases and silently misses every existing one.
//
// Stories are what finally forced it. "Contacts" is the default story
// audience, and a privacy setting that silently means "nobody" — because the
// table it names does not exist — is worse than not offering the setting.
//
// Deliberately one-directional. Adding someone is not mutual and does not
// notify them: a contact list is a private annotation on your own account,
// not a relationship both parties agree to.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS contacts (
    owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_name text,
    last_name  text,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id),
    CHECK (owner_id <> contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts (owner_id);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_contacts_owner;
DROP TABLE IF EXISTS contacts;
  `);
}
