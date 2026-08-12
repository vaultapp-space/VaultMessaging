#!/usr/bin/env bash
#
# Deploy the current main to the production VPS. Runs ON the box:
#
#   ssh ubuntu@vaultapp.space 'bash /home/ubuntu/VaultMessaging/deploy/deploy.sh'
#
# This exists because v1.26 was published as an APK, an F-Droid index and a
# GitHub release without the server ever being redeployed. Every `/api/posts/*`
# route the new feed called returned 404 for every user, and the release path
# had no step that would have caught it. Deploying was a sequence of remembered
# commands; now it is a file.
#
# Pair it with deploy/preflight.sh, which runs locally and refuses to let a
# release go out against a server that is behind.
set -euo pipefail

REPO=/home/ubuntu/VaultMessaging
BRANCH=main

# Secrets (JWT_SECRET, TURN_SECRET, PGPASSWORD) live in the shell environment,
# not in the repo — see ecosystem.config.cjs. Migrations need the PG ones, so
# source the box's env file if it exists.
[ -f /home/ubuntu/.vault-env ] && . /home/ubuntu/.vault-env

# Fallback: lift it from the running process. PM2 holds the environment the
# server was started with, which necessarily includes a working PGPASSWORD —
# the server cannot have been serving without one. This is what makes the
# script work on a box that has no .vault-env yet, over an ssh command whose
# non-interactive shell never sourced a profile.
if [ -z "${PGPASSWORD:-}" ] && command -v pm2 >/dev/null 2>&1; then
  PGPASSWORD=$(pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const app = JSON.parse(s).find((a) => a.name === "vault-server");
        process.stdout.write(app?.pm2_env?.PGPASSWORD ?? "");
      } catch { /* no pm2 output to parse */ }
    });
  ') || true
  [ -n "${PGPASSWORD:-}" ] && export PGPASSWORD
fi

if [ -z "${PGPASSWORD:-}" ]; then
  echo "FATAL: PGPASSWORD is not set, so migrations cannot run." >&2
  echo "Put it (and JWT_SECRET/TURN_SECRET) in /home/ubuntu/.vault-env." >&2
  exit 1
fi

cd "$REPO"

echo "==> Fetching $BRANCH"
git fetch origin "$BRANCH"

# Refuse to deploy over uncommitted edits rather than silently stashing or
# clobbering them. A dirty production checkout means someone hot-patched the
# box, and that change needs to reach the repo before it is overwritten.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "FATAL: the checkout at $REPO has uncommitted changes." >&2
  git status --short >&2
  exit 1
fi

BEFORE=$(git rev-parse HEAD)
# --ff-only: a merge commit created on the production box would fork history.
git merge --ff-only "origin/$BRANCH"
AFTER=$(git rev-parse HEAD)
echo "==> ${BEFORE:0:12} -> ${AFTER:0:12}"

echo "==> Installing server dependencies"
npm ci --prefix server --omit=dev

echo "==> Running migrations"
# Before the restart: the new code may require the new schema. Migrations here
# are additive, so the still-running old process tolerates them for the few
# seconds until it is replaced.
npm run migrate --prefix server -- up

echo "==> Restarting the server"
# Deliberately NOT --update-env. PM2 has the secrets from whenever it was first
# started; --update-env would replace that environment with this shell's, and
# config.js refuses to boot in production when JWT_SECRET/TURN_SECRET are unset
# — so the "safer looking" flag is the one that takes the site down.
pm2 restart vault-server

echo "==> Waiting for the server to come back"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo "    healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FATAL: server did not become healthy within 30s." >&2
    pm2 logs vault-server --lines 40 --nostream >&2 || true
    exit 1
  fi
  sleep 1
done

# The client is built and swapped last, so there is never a window where a
# freshly loaded page calls routes the running server does not have yet. nginx
# serves client/dist straight out of this checkout, so the build is the deploy.
echo "==> Building the client"
npm ci --prefix client
npm run build --prefix client

echo "==> Verifying"
SERVING=$(curl -fsS --max-time 10 http://127.0.0.1:3001/health \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).build?.commit??"unknown"))')

if [ "$SERVING" != "$AFTER" ]; then
  echo "FATAL: /health reports $SERVING but the checkout is at $AFTER." >&2
  echo "The restart did not pick up the new code." >&2
  exit 1
fi

echo "==> Deployed ${AFTER:0:12}"
