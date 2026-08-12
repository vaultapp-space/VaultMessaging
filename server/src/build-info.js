// ============================================================
// What commit this process is actually running
// ============================================================
// Exists because of a real incident: v1.26 shipped an APK whose entire feed
// called `/api/posts/*`, and the server on the VPS had never been redeployed,
// so every one of those routes 404'd for every user. Nothing in the release
// path noticed, because nothing in the release path could *see* what the
// server was running.
//
// `/health` now reports this, and `deploy/preflight.sh` compares it against
// the commit being released. That turns "the server is stale" from something
// you discover from a user report into something that fails the release.
//
// Read straight out of `.git` rather than shelling out to `git rev-parse`: no
// subprocess at boot, and it still works on a box where git is not installed.
// `VAULT_COMMIT` takes precedence for deploys that ship without a `.git` at
// all (a container image, say), where the value has to be stamped in.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readGitCommit() {
  try {
    const head = readFileSync(join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim();

    // Detached HEAD stores the sha directly; a normal checkout stores a ref.
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/.test(head) ? head : null;

    const ref = head.slice(4).trim();
    try {
      return readFileSync(join(REPO_ROOT, '.git', ref), 'utf8').trim();
    } catch {
      // A ref that has been packed has no loose file. This is the normal state
      // for a fresh `git clone`, which is exactly how the VPS checkout starts,
      // so the fallback is the common path there rather than an edge case.
      const packed = readFileSync(join(REPO_ROOT, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.split(' ')[0] : null;
    }
  } catch {
    // No .git, or it is unreadable. Reporting null is honest; guessing is not.
    return null;
  }
}

const commit = process.env.VAULT_COMMIT?.trim() || readGitCommit();

export const buildInfo = {
  commit,
  // Short form is what a human compares by eye against `git log --oneline`.
  commitShort: commit ? commit.slice(0, 12) : null,
  startedAt: new Date().toISOString(),
};
