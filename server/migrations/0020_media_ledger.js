// ============================================================
// 0020 — the media ledger
// ============================================================
// Closes a hole that predates Thoughts and that Thoughts made worth exploiting.
//
// `POST /api/media/upload` writes a file to disk and returns a fileId. If the
// client never goes on to reference that fileId in a post, story or sticker,
// **nothing deletes the file, ever** — the reaper only walks content rows, and
// there is no content row. Worse, `phase8.repo.canViewMediaFile` is
// deny-by-exception: a file no row claims is served to any authenticated user.
// So an unreferenced upload is a permanent, publicly readable file.
//
// That was survivable when signup implied someone you had chosen to talk to.
// A public feed with anonymous signup turns it into free file hosting on
// someone else's disk, and the content is served from your domain.
//
// The ledger records every upload and whether anything ever claimed it.
// Unclaimed rows past a short grace period are reaped with their files.
//
// **The grace period is what makes this safe.** Upload and reference are two
// requests: the composer uploads when the image is picked and references it
// when Post is tapped, which can be minutes later, and is abandoned entirely if
// the user changes their mind. Reaping instantly would delete the image out
// from under a composer that is still open. An hour is far longer than any
// real compose session and far shorter than "forever".
//
// **Files with no ledger row are never touched.** Every upload from before this
// migration has no row here, and the reaper deletes files by walking this
// table — never by listing the directory and deleting what it cannot account
// for. That direction is deliberate: the failure mode of the other one is
// deleting every existing sticker in the instance.

export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
CREATE TABLE IF NOT EXISTS media_files (
    -- Matches the fileId returned by the upload route. Not a FK to anything:
    -- the file is the thing that exists, and the content row referencing it
    -- may never be created.
    file_id     uuid PRIMARY KEY,
    -- Who uploaded it, so an abusive uploader can be found from a file alone.
    -- CASCADE: deleting the account should take the ledger row with it, and
    -- the reaper then treats the file as an orphan and removes it.
    uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Recorded at upload from the mime allowlist rather than guessed later.
    -- The story and post reapers currently try all four known extensions
    -- against the filesystem because nothing stored which one was written;
    -- storing it makes the unlink exact.
    extension   text NOT NULL,
    -- NULL until some content row references this file. Set once and left —
    -- it marks "was claimed", not "is currently referenced", because the
    -- content row it belonged to may since have expired and taken the file
    -- with it.
    claimed_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The reaper's only query: unclaimed rows older than the grace period. Partial,
-- so it holds just the candidates rather than every file ever uploaded, and
-- rows leave the index as soon as they are claimed.
CREATE INDEX IF NOT EXISTS idx_media_files_unclaimed
    ON media_files (created_at)
    WHERE claimed_at IS NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
DROP INDEX IF EXISTS idx_media_files_unclaimed;
DROP TABLE IF EXISTS media_files;
  `);
}
