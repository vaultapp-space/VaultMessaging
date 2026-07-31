-- ============================================================
-- Vault — Initial Database Schema
-- Zero PII · Encrypted Blobs · 24h Hard Deletion Ceiling
--
-- This file is not executed by the app — server/src/store.js runs the
-- same CREATE TABLE IF NOT EXISTS statements itself on every boot, so
-- the running schema is always self-migrating from that single source
-- of truth. This file exists purely as documentation of the schema and
-- for anyone who wants to provision the database without booting the
-- app first; keep it in sync with the initSchemaSQL block in store.js.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── USERS ─────────────────────────────────────────────────
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

-- ─── ONE-TIME PREKEYS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key      TEXT NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    uploaded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_user_unused ON one_time_prekeys (user_id, used)
    WHERE used = FALSE;

-- ─── ENCRYPTED MESSAGES ────────────────────────────────────
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

-- ─── GROUPS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    join_key        TEXT UNIQUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

-- ─── ATTACHMENTS (disk-backed chunks, DB tracks metadata only) ──
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

-- ─── PUSH SUBSCRIPTIONS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription    TEXT NOT NULL,
    PRIMARY KEY (user_id, subscription)
);

-- ─── SERVER CONFIG (persisted key/value, e.g. VAPID keys) ──
CREATE TABLE IF NOT EXISTS server_config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
);
