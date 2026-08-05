// ============================================================
// 0010 — Phase 4: devices and the per-user update log
// ============================================================
// Two things arrive here, and the second is the load-bearing one.
//
// `devices` turns a session from an anonymous JWT into something a user can
// see and revoke. Today a session is a bare Redis key: there is no way to
// answer "what is logged in to my account?", and no way to sign out a phone
// you no longer have. Both are table stakes for a messenger, and neither is
// possible without a durable row per device.
//
// `user_updates` is the sync spine. A device that was offline needs to find
// out what it missed, and the current answer — a `delivered` boolean per
// message — cannot work once one account has several devices, because
// "delivered" has no single answer. Telegram's model replaces it with a
// per-user monotonic `pts`: every state change appends an update, a client
// reports the last `pts` it saw, and the server replays the difference.
//
// The 24-hour rule reaches into this, and it matters more here than anywhere
// else in the schema. An update row carries a copy of the message body, so an
// update log that outlived its messages would quietly become the archive this
// product is built not to have. `expires_at` is therefore NOT NULL and the
// reaper clears it on the same schedule as everything else. A device offline
// for more than a day gets `tooLong` and refetches — which is exactly right,
// because there is nothing older than a day for it to catch up on.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Devices ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           text,
    platform       text,
    app_version    text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    -- Coarse only, and never shown to anyone but the account owner: it is
    -- there to answer "is this login mine?", not to build a location history.
    last_ip        inet,
    -- How far this device has caught up. Kept per device, not per user,
    -- because that is the entire point of the column.
    pts            bigint NOT NULL DEFAULT 0,
    revoked_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id, last_active_at DESC);

-- ─── The update log ─────────────────────────────────────────
-- One monotonic counter per user, allocated the same way message seq is:
-- an UPDATE ... RETURNING inside the writing transaction, which serialises
-- concurrent writers without a separate lock.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pts bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_updates (
    user_id    uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pts        bigint NOT NULL,
    kind       text   NOT NULL,
    payload    jsonb  NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- NOT NULL on purpose. These rows carry message content; an update log
    -- without an expiry is a second, permanent copy of every conversation.
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, pts)
);

CREATE INDEX IF NOT EXISTS idx_user_updates_expiry ON user_updates (expires_at);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_user_updates_expiry;
DROP TABLE IF EXISTS user_updates;
ALTER TABLE users DROP COLUMN IF EXISTS pts;

DROP INDEX IF EXISTS idx_devices_user;
DROP TABLE IF EXISTS devices;
  `);
}
