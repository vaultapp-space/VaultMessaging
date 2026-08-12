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

# Secrets (JWT_SECRET, TURN_SECRET, and PGPASSWORD if one is set) live in the
# shell environment rather than the repo — see ecosystem.config.cjs. Source the
# box's env file if it has one; an ssh command runs a non-interactive shell and
# sources no profile of its own.
[ -f /home/ubuntu/.vault-env ] && . /home/ubuntu/.vault-env

# Deliberately NOT requiring PGPASSWORD here. scripts/migrate.js builds its
# connection string from src/db/config.js — the same module src/store.js uses —
# precisely so that migrations cannot be applied to a different database than
# the one the app talks to. Demanding the variable separately would break that
# guarantee rather than strengthen it: the deploy would fail on a box where the
# server itself is perfectly able to connect.
#
# On the current production box no PGPASSWORD is set at all, so both fall
# through to the `vault_dev_pass` default in that file. That is a finding, not
# a design — it is tracked separately, and rotating it means setting the
# variable here and in PM2 together.

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
# Not --omit=dev: node-pg-migrate is a devDependency and the migration step
# below runs its binary out of node_modules/.bin. Omitting dev deps removes it,
# and scripts/migrate.js then exits 1 without printing anything, because
# spawnSync on a missing binary reports no status. That combination cost a
# deploy — the server was left running old code while npm reported success.
npm ci --prefix server

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
