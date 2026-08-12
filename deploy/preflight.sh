#!/usr/bin/env bash
#
# Run this LOCALLY before publishing an APK, an F-Droid index or a GitHub
# release:
#
#   ./deploy/preflight.sh
#
# It answers one question: is the server the app will talk to actually running
# the code this release was built against?
#
# v1.26 shipped a whole feed whose every request 404'd, because the answer was
# no and nothing asked. Exit code is non-zero when the release should not go
# out.
set -euo pipefail

HOST=${VAULT_HOST:-https://vaultapp.space}
LOCAL=$(git rev-parse HEAD)

echo "==> Local HEAD:  ${LOCAL:0:12}"

HEALTH=$(curl -fsS --max-time 20 "$HOST/health") || {
  echo "FAIL: $HOST/health is unreachable." >&2
  exit 1
}

REMOTE=$(printf '%s' "$HEALTH" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).build?.commit??""))')

if [ -z "$REMOTE" ]; then
  echo "FAIL: $HOST/health reports no build.commit." >&2
  echo "      That server predates deploy/preflight.sh itself — deploy it first:" >&2
  echo "      ssh ubuntu@vaultapp.space 'bash /home/ubuntu/VaultMessaging/deploy/deploy.sh'" >&2
  exit 1
fi

echo "==> Server HEAD: ${REMOTE:0:12}"

if [ "$REMOTE" = "$LOCAL" ]; then
  echo "==> OK: the server is running this exact commit."
  exit 0
fi

# Not equal. Distinguish "server is behind" (the dangerous case, and the one
# that caused the incident) from "server is ahead" or "unrelated history".
if git merge-base --is-ancestor "$REMOTE" "$LOCAL" 2>/dev/null; then
  BEHIND=$(git rev-list --count "$REMOTE..$LOCAL")
  echo "FAIL: the server is $BEHIND commit(s) BEHIND this release." >&2
  echo "      Anything added since ${REMOTE:0:12} does not exist in production." >&2
  echo "      Deploy first:" >&2
  echo "      ssh ubuntu@vaultapp.space 'bash /home/ubuntu/VaultMessaging/deploy/deploy.sh'" >&2
  exit 1
fi

if git merge-base --is-ancestor "$LOCAL" "$REMOTE" 2>/dev/null; then
  echo "FAIL: the server is AHEAD of this release — you are building an old commit." >&2
  exit 1
fi

echo "FAIL: the server is on ${REMOTE:0:12}, which is not in this branch's history." >&2
exit 1
