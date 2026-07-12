-- ============================================================
-- Vault — Initial Database Schema
-- Zero PII · Encrypted Blobs · 24h Hard Deletion Ceiling
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── USERS ─────────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    identity_key    BYTEA NOT NULL,
    signed_prekey   BYTEA NOT NULL,
    prekey_sig      BYTEA NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_users_username ON users (username);

-- ─── ONE-TIME PREKEYS ──────────────────────────────────────
CREATE TABLE one_time_prekeys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key      BYTEA NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    uploaded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_otp_user_unused ON one_time_prekeys (user_id, used)
    WHERE used = FALSE;

-- ─── ENCRYPTED MESSAGES ────────────────────────────────────
CREATE TABLE encrypted_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext      BYTEA NOT NULL,
    ephemeral_key   BYTEA,
    message_number  INTEGER NOT NULL,
    previous_chain  INTEGER DEFAULT 0,
    sent_at         TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    delivered       BOOLEAN DEFAULT FALSE,

    CONSTRAINT chk_expires_max CHECK (
        expires_at <= sent_at + INTERVAL '24 hours'
    )
);

CREATE INDEX idx_msg_recipient_undelivered
    ON encrypted_messages (recipient_id, delivered, sent_at)
    WHERE delivered = FALSE;

CREATE INDEX idx_msg_expires
    ON encrypted_messages (expires_at);

CREATE INDEX idx_msg_conversation
    ON encrypted_messages (
        LEAST(sender_id, recipient_id),
        GREATEST(sender_id, recipient_id),
        sent_at DESC
    );

-- ─── ENCRYPTED MEDIA ───────────────────────────────────────
CREATE TABLE encrypted_media (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id      UUID REFERENCES encrypted_messages(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    total_chunks    INTEGER NOT NULL,
    encrypted_blob  BYTEA NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,

    CONSTRAINT chk_media_expires CHECK (
        expires_at <= now() + INTERVAL '24 hours'
    ),
    UNIQUE (message_id, chunk_index)
);

CREATE INDEX idx_media_expires ON encrypted_media (expires_at);
