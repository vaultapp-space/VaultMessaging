#!/usr/bin/env bash
#
# Publishes a fresh client/dist as an over-the-air content update for the
# Android app. Run on the VPS as the last step of the existing manual
# deploy flow, after `git pull && npm run build` in client/ — see
# ios/README.md-equivalent android/README.md for the full deploy sequence.
#
# What this does, plainly: zips client/dist, sha256s the zip, and writes
# the manifest client/src/lib/capacitor/updater.js polls on launch
# (https://vaultapp.space/ota/check, see deploy/nginx/vaultapp.space.conf).
# The zip and manifest are runtime artifacts, not source — not git-tracked,
# same treatment as server/uploads/.
#
# Deliberately a static, single-latest-version manifest, matching
# @capgo/capacitor-updater's simplest self-hosted mode: no channels, no
# per-device rollout, no delta manifests. Good enough for one developer
# shipping updates by hand; revisit if that ever changes.
#
# One-time setup this assumes: `sudo apt install zip` (not installed by
# default on Ubuntu).
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: publish-ota.sh <version>" >&2
  echo "  e.g. publish-ota.sh \$(node -p \"require('./client/package.json').version\")" >&2
  exit 1
fi
VERSION="$1"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$REPO_ROOT/client/dist"
OUT="$REPO_ROOT/ota"

if [ ! -f "$DIST/index.html" ]; then
  echo "error: $DIST/index.html not found — run npm run build in client/ first" >&2
  exit 1
fi

mkdir -p "$OUT/bundles"
ZIP="$OUT/bundles/${VERSION}.zip"

# -X drops extended attributes/timestamps that would make the zip (and so
# its checksum) non-reproducible across machines for the same source tree.
# The bundle's own index.html must sit at the zip root, not nested under a
# dist/ folder, or the plugin can't find it after unpacking.
( cd "$DIST" && zip -r -X -q "$ZIP" . )

CHECKSUM=$(sha256sum "$ZIP" | awk '{print $1}')

cat > "$OUT/check" <<EOF
{"version":"${VERSION}","url":"https://vaultapp.space/ota/bundles/${VERSION}.zip","checksum":"${CHECKSUM}"}
EOF

echo "Published OTA bundle ${VERSION}"
echo "  zip:      $ZIP"
echo "  sha256:   $CHECKSUM"
echo "  manifest: $OUT/check"
