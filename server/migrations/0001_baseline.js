// ============================================================
// 0001 — Baseline schema
// ============================================================
// This is the schema that used to be applied on every boot by
// `initSchemaSQL` in src/store.js. It is reproduced verbatim, which matters:
// every statement is idempotent (IF NOT EXISTS), so running this against the
// existing production database is a no-op and converges it with a fresh one.
// From 0002 onward, migrations may assume they are the only writer of schema.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    identity_key    TEXT NOT NULL,
    signed_prekey   TEXT NOT NULL,
    prekey_sig      TEXT NOT NULL,
    salt            TEXT NOT NULL,
    encrypted_vault TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key      TEXT NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    uploaded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_user_unused ON one_time_prekeys (user_id, used)
    WHERE used = FALSE;

CREATE TABLE IF NOT EXISTS encrypted_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext      TEXT NOT NULL,
    ephemeral_key   TEXT,
    message_number  INTEGER NOT NULL,
    previous_chain  INTEGER DEFAULT 0,
    sent_at         TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    delivered       BOOLEAN DEFAULT FALSE,
    read            BOOLEAN DEFAULT FALSE,
    iv              TEXT,
    group_id        TEXT,
    attachment_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_recipient_undelivered
    ON encrypted_messages (recipient_id, delivered, sent_at)
    WHERE delivered = FALSE;

CREATE INDEX IF NOT EXISTS idx_msg_expires ON encrypted_messages (expires_at);

CREATE INDEX IF NOT EXISTS idx_msg_conversation ON encrypted_messages (sender_id, recipient_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_msg_conversation_rev ON encrypted_messages (recipient_id, sender_id, sent_at);

CREATE TABLE IF NOT EXISTS groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    join_key        TEXT UNIQUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Kept because deployed databases predate created_by being part of the CREATE
-- above; harmless on a fresh database.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS group_members (
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    total_chunks    INTEGER NOT NULL DEFAULT 1,
    uploaded_chunks INTEGER NOT NULL DEFAULT 0,
    burn_on_read    BOOLEAN DEFAULT FALSE,
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachment_allowed_users (
    attachment_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (attachment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_expires ON attachments (expires_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription    TEXT NOT NULL,
    PRIMARY KEY (user_id, subscription)
);

CREATE TABLE IF NOT EXISTS server_config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);
  `);
}

export async function down(pgm) {
  // Order matters: children before parents. Only used to prove the migration
  // is reversible in CI — never run against production.
  pgm.sql(`
DROP TABLE IF EXISTS server_config;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS attachment_allowed_users;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS encrypted_messages;
DROP TABLE IF EXISTS one_time_prekeys;
DROP TABLE IF EXISTS users;
  `);
}
