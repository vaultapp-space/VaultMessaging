// ============================================================
// 0012 — Phase 6: stickers and custom emoji
// ============================================================
// Scope note, because this phase is where a plan usually overruns: **static,
// WebP and WebM only.** Lottie/TGS animated stickers are deliberately not
// here. Rendering them means shipping rlottie-wasm (500KB+ of WebAssembly)
// and doing real mobile performance work, which is a phase of its own — and
// the format work, not the CRUD, is what makes animated stickers expensive.
// The schema carries `is_animated` so adding them later is a renderer change
// rather than a migration.
//
// Two retention decisions worth being explicit about, because stickers look
// like an exception to the 24-hour rule and are not:
//
//   - **A sticker *set* is not message content.** It is a library the user
//     installed, like an app preference, so it persists. Nothing about a set
//     reveals what anyone said.
//
//   - **A sticker *sent in a chat* is an ordinary message** and expires with
//     every other one. The message stores a reference to the sticker, not a
//     copy, so the message expiring leaves the set untouched — and the set
//     existing tells nobody that it was ever used in a conversation.
//
// `recent_stickers` is the one place those two meet, and it is capped rather
// than expiring: a recents list that survived forever would be a slow leak of
// what you have been sending, which is exactly the kind of metadata this
// product otherwise refuses to keep.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
-- ─── Sets ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sticker_sets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    short_name     text UNIQUE NOT NULL,
    title          text NOT NULL,
    owner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    -- 'regular' stickers go in the picker; 'emoji' ones render inline in
    -- message text through the entity system from 0.6, which is precisely
    -- why entities had to exist before this phase.
    type           text NOT NULL DEFAULT 'regular'
                     CHECK (type IN ('regular', 'emoji', 'mask')),
    thumb_file_id  uuid,
    is_official    boolean NOT NULL DEFAULT false,
    installs_count int NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sticker_sets_owner ON sticker_sets (owner_id);

-- ─── Stickers ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stickers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id      uuid NOT NULL REFERENCES sticker_sets(id) ON DELETE CASCADE,
    file_id     uuid NOT NULL,
    -- The emoji this sticker stands for. Drives the suggestion that turns
    -- typing an emoji into a sticker offer.
    emoji       text,
    position    int NOT NULL DEFAULT 0,
    width       int,
    height      int,
    is_animated boolean NOT NULL DEFAULT false,
    is_video    boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_stickers_set ON stickers (set_id, position);
CREATE INDEX IF NOT EXISTS idx_stickers_emoji ON stickers (emoji) WHERE emoji IS NOT NULL;

-- ─── Installed sets ─────────────────────────────────────────
-- A library, not message content: it persists, and it reveals nothing about
-- any conversation.

CREATE TABLE IF NOT EXISTS user_sticker_sets (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id       uuid NOT NULL REFERENCES sticker_sets(id) ON DELETE CASCADE,
    position     int NOT NULL DEFAULT 0,
    installed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, set_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sticker_sets_user
    ON user_sticker_sets (user_id, position);

CREATE TABLE IF NOT EXISTS favorite_stickers (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id uuid NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, sticker_id)
);

-- ─── Recents ────────────────────────────────────────────────
-- Capped in the repo rather than given an expiry. An uncapped recents list is
-- a slow-accumulating record of what you have been sending — the kind of
-- metadata this product refuses to keep everywhere else, so it should not
-- appear here by accident.

CREATE TABLE IF NOT EXISTS recent_stickers (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id uuid NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    used_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, sticker_id)
);

CREATE INDEX IF NOT EXISTS idx_recent_stickers_user
    ON recent_stickers (user_id, used_at DESC);
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_recent_stickers_user;
DROP TABLE IF EXISTS recent_stickers;
DROP TABLE IF EXISTS favorite_stickers;
DROP INDEX IF EXISTS idx_user_sticker_sets_user;
DROP TABLE IF EXISTS user_sticker_sets;
DROP INDEX IF EXISTS idx_stickers_emoji;
DROP INDEX IF EXISTS idx_stickers_set;
DROP TABLE IF EXISTS stickers;
DROP INDEX IF EXISTS idx_sticker_sets_owner;
DROP TABLE IF EXISTS sticker_sets;
  `);
}
