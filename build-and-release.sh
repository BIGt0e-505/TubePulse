#!/bin/bash
set -euo pipefail

# ============================================================
# TubePulse — Local APK Build & GitHub Release
# ============================================================
# Usage: ./build-and-release.sh <version> [<branch>]
#   e.g., ./build-and-release.sh 3.0.13
#   e.g., ./build-and-release.sh 3.0.13 v3-restored
#
# If no branch is given, the current branch is used.
# Secrets must be loaded first:
#   source secrets/load-secrets.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR"
REPO="Undert0e-505/TubePulse"
APP_NAME="TubePulse"
GH="$(command -v gh || echo "$HOME/bin/gh")"
ENV_SCRIPT="$HOME/.openclaw/workspace/android-env.sh"

# --- Source environment ---
source "$ENV_SCRIPT"

# --- Use D drive for temp files ---
export TMPDIR="/mnt/d/tmp"
export TEMP="/mnt/d/tmp"
export TMP="/mnt/d/tmp"
mkdir -p "$TMPDIR"

# --- Parse args ---
VERSION="${1:?Usage: build-and-release.sh <version> [<branch>]}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"
TAG="v${VERSION}"

echo "======================================"
echo "  ${APP_NAME} — Build & Release ${TAG}"
echo "  Branch: ${BRANCH}"
echo "======================================"

# --- Check if tag already exists ---
if "$GH" release view "$TAG" --repo "$REPO" &>/dev/null; then
    echo "ERROR: Release ${TAG} already exists!"
    exit 1
fi

cd "$REPO_DIR"

# --- Step 1: Update version in app.json ---
echo ""
echo "[1/5] Updating version to ${VERSION}..."
node -e "
  const fs = require('fs');
  const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  app.expo.version = '${VERSION}';
  fs.writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
  console.log('  app.json updated: ' + app.expo.version);
"

# --- Step 2: Install dependencies ---
echo ""
echo "[2/5] Installing dependencies..."
npm install --silent 2>&1 | tail -3

# --- Step 2b: Pre-build native android project ---
# (Only needed if Expo plugins/native deps changed since last build.
# The first time, or after changing google-services.json etc., this is
# essential — otherwise eas local will use stale native code.)
echo ""
echo "[2b/5] Pre-building native android project..."
if npx expo prebuild --clean --no-install 2>&1 | tail -5; then
  echo "  prebuild OK"
else
  echo "  prebuild failed or skipped, continuing anyway"
fi

# --- Step 3: Build APK locally ---
echo ""
echo "[3/5] Building APK locally (this takes 5-15 minutes)..."
APK_OUTPUT="${APP_NAME}-v${VERSION}.apk"

eas build --local \
    --platform android \
    --profile preview \
    --output "$APK_OUTPUT" \
    --non-interactive

if [ ! -f "$APK_OUTPUT" ]; then
    echo "ERROR: APK not found at ${APK_OUTPUT}"
    FOUND_APK=$(ls -t *.apk 2>/dev/null | head -1)
    if [ -n "$FOUND_APK" ]; then
        echo "  Found APK: ${FOUND_APK}, renaming..."
        mv "$FOUND_APK" "$APK_OUTPUT"
    else
        echo "  No APK file found. Build may have failed."
        exit 1
    fi
fi

APK_SIZE=$(du -h "$APK_OUTPUT" | cut -f1)
echo "  APK built: ${APK_OUTPUT} (${APK_SIZE})"

# --- Step 4: Commit and push ---
echo ""
echo "[4/5] Committing version bump and pushing to ${BRANCH}..."
git add app.json
git commit -m "Bump version to ${VERSION}" || echo "  No changes to commit"
git push origin "${BRANCH}"

# --- Step 5: Create GitHub release ---
echo ""
echo "[5/5] Creating GitHub release ${TAG}..."
"$GH" release create "$TAG" "$APK_OUTPUT" \
    --repo "$REPO" \
    --title "${APP_NAME} ${TAG}" \
    --notes "$(cat <<EOF
## ${APP_NAME} ${TAG}

YouTube channel watcher widget for Android.

### Features
- Monitor YouTube channels for new uploads
- Home screen widget with channel avatars and status indicators
- Notifications when new videos are posted
- Configurable: tap to open video or channel page
- Dark mode with translucent widget background

### Pre-seeded channels
- @mattdoesartandstuff
- @DNDrebeccaAFTG

### Installation
1. Download \`${APK_OUTPUT}\` below
2. Transfer to your Android device (or download directly on phone)
3. Enable 'Install from Unknown Sources' if prompted
4. Install and open
5. Long-press home screen → Widgets → TubePulse to add widget
EOF
)" \
    --latest

echo ""
echo "======================================"
echo "  Release created!"
echo "  https://github.com/${REPO}/releases/tag/${TAG}"
echo "======================================"

rm -f "$APK_OUTPUT"
