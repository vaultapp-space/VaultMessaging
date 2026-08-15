#!/usr/bin/env bash
#
# Deploy web-only changes without cutting an app release.
#
#   bash deploy/release-web.sh
#
# WHY THIS EXISTS
#
# The Android app is a Capacitor wrapper: `cap sync` copies client/dist
# wholesale into the APK, so the landing page is bundled into every build. It
# is never rendered there. App.svelte branches on Capacitor.isNativePlatform()
# and shows NativeWelcome, so <Landing /> is dead code on Android.
#
# v1.42 and v1.43 were both landing-page releases. Each one bumped
# versionCode, rebuilt and signed an APK, published an F-Droid index and cut a
# GitHub release — and changed nothing an Android user could see. Every
# installed app prompted for an update that contained, for them, a few hundred
# bytes of markup they will never render.
#
# This path deploys the website and stops. No version bump, no APK, no
# F-Droid, no tag. The version number goes back to meaning "the app changed".
#
# WHAT MAKES THIS SAFE
#
# The hard part is not skipping steps, it is knowing you are allowed to. This
# script decides for you: it diffs against the last release tag and refuses
# unless every changed path is on the allowlist below.
#
# The list is an allowlist, not a denylist, and that direction is deliberate.
# An unrecognised path fails the check and sends you to the full release —
# which is merely slower. A denylist would have to enumerate every file that
# reaches the app, and anything forgotten ships silently.
#
# Note what is NOT here: client/index.html and client/src/main.js. Both are
# the app's own shell, they run on Android, and a change to either needs an
# APK. That is exactly why v1.44 was a full release while its two
# predecessors should not have been.
set -euo pipefail

cd "$(dirname "$0")/.."

# Paths that cannot change what an Android user sees. Landing and its icon
# component are dead code under Capacitor. Everything in client/public is
# served by nginx: the APK carries copies as inert bytes and reads none of
# them — no PWA manifest, no robots.txt, no sitemap, no OG image.
WEB_ONLY=(
  'client/src/components/Landing.svelte'
  'client/src/components/LandingIcon.svelte'
  'client/src/prerender-entry.js'
  'client/scripts/prerender.mjs'
  'client/public/'
  'deploy/'
  'docs/'
  'README.md'
)

LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
if [ -z "$LAST_TAG" ]; then
  echo "FAIL: no v* tag found, so there is no baseline to diff against."
  exit 1
fi

echo "==> Comparing HEAD against $LAST_TAG"
CHANGED=$(git diff --name-only "$LAST_TAG..HEAD")

if [ -z "$CHANGED" ]; then
  echo "Nothing has changed since $LAST_TAG. Nothing to deploy."
  exit 0
fi

BLOCKERS=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  ok=0
  for allowed in "${WEB_ONLY[@]}"; do
    case "$file" in
      "$allowed"*) ok=1; break ;;
    esac
  done
  [ "$ok" -eq 0 ] && BLOCKERS="$BLOCKERS  $file"$'\n'
done <<< "$CHANGED"

if [ -n "$BLOCKERS" ]; then
  echo
  echo "FAIL: these changed files are outside the web-only allowlist:"
  echo "$BLOCKERS"
  echo "      Most such files reach the Android app, and a web-only deploy"
  echo "      would leave the APK behind on them. Cut a full release: bump"
  echo "      versionCode/versionName in android/app/build.gradle and follow"
  echo "      android/README.md."
  echo
  echo "      Server-only changes are the exception — they never ship in the"
  echo "      APK. They are blocked here because this script's job is the"
  echo "      website; deploy them with deploy/deploy.sh directly, which is"
  echo "      what this script calls anyway."
  exit 1
fi

echo "==> Web-only. Changed since $LAST_TAG:"
echo "$CHANGED" | sed 's/^/  /'

# Uncommitted work would be silently skipped: deploy.sh pulls origin/main on
# the box, so anything not pushed simply does not exist as far as the deploy
# is concerned.
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree is dirty. Commit or stash before deploying."
  exit 1
fi

if [ -n "$(git log origin/main..HEAD --oneline)" ]; then
  echo "FAIL: HEAD is ahead of origin/main. Push first — the box pulls."
  exit 1
fi

echo "==> Deploying to production"
ssh -i vps_key.pem ubuntu@vaultapp.space 'bash /home/ubuntu/VaultMessaging/deploy/deploy.sh'

echo "==> Verifying"
bash deploy/preflight.sh

echo
echo "==> Website updated. No app release cut, and none was needed."
