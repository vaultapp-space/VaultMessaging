-- ============================================================
-- Vault — Initial Database Schema
-- Zero PII · Encrypted Blobs · 24h Hard Deletion Ceiling
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

CREATE INDEX IF NOT EXISTS idx_msg_expires
    ON encrypted_messages (expires_at);

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

-- ─── ENCRYPTED MEDIA METADATA ──────────────────────────────
CREATE TABLE IF NOT EXISTS encrypted_media (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID REFERENCES encrypted_messages(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    file_path       TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    UNIQUE (message_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_media_expires ON encrypted_media (expires_at);
