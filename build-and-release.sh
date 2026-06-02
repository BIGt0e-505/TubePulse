#!/bin/bash
# ============================================================
# TubePulse -- Local APK Build & GitHub Release (WSL-native)
# ============================================================
# Uses the Android SDK and JDK installed on Windows.
# No EAS, no Cloudflare cloud, no PowerShell dance.
# Just gradle, calling Windows binaries from WSL.
#
# Usage:
#   ./build-and-release.sh 3.0.13                # build only, current branch
#   ./build-and-release.sh 3.0.18 master              # build + commit + push + gh release
#   ./build-and-release.sh 3.0.18 master --build-only  # skip git push + gh release
#   ./build-and-release.sh 3.0.18 master --clean         # nuke gradle cache first
#
# Requirements (all already on the Windows host):
#   - JDK 17 or 21 at C:\Program Files\Java\jdk-XX
#   - Android SDK at C:\Program Files (x86)\Android\android-sdk
#   - GitHub CLI (gh.exe) on PATH for the release step
# ============================================================

set -euo pipefail

# --- Constants ---
APP_NAME="TubePulse"
REPO="Undert0e-505/TubePulse"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR"
GH="$(command -v gh || echo "$HOME/bin/gh")"

# Android SDK + JDK live in WSL (NOT on Windows at C:\Program Files (x86)\Android\).
# The Windows SDK install is stale and missing the NDK. Use the WSL one -- it has
# build-tools 35.0.0, platforms android-36, and ndk 27.1.12297006 (the exact
# version RN 0.81 requires).
ANDROID_SDK="/home/openclaw/Android/Sdk"
JDK_PATH="/home/openclaw/.local/lib/jdk-17.0.13+11"

# --- Parse args ---
VERSION="${1:?Usage: build-and-release.sh <version> [<branch>] [--build-only] [--clean]}"
BRANCH="${2:-}"
BUILD_ONLY=0
CLEAN=0
shift 2 2>/dev/null || shift 1
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --clean) CLEAN=1 ;;
  esac
done

if [ -z "$BRANCH" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi
TAG="v${VERSION}"
APK_OUTPUT="${APP_NAME}-${TAG}.apk"

# --- Banner ---
echo "=========================================="
echo "  ${APP_NAME} - Build and Release ${TAG}"
echo "  Branch: ${BRANCH}"
echo "  Android SDK: ${ANDROID_SDK}"
echo "  JDK: ${JDK_PATH}"
echo "=========================================="
echo ""

# --- Verify tools ---
echo "[0/6] Verifying build tools..."

if [ ! -x "${JDK_PATH}/bin/java" ]; then
  echo "  ERROR: java not found at ${JDK_PATH}/bin/java" >&2
  echo "  Set JDK_PATH in this script or install JDK 17" >&2
  exit 1
fi
java_version="$("${JDK_PATH}/bin/java" -version 2>&1 | head -1)"
echo "  ${java_version}  ✓"

if [ ! -f "${ANDROID_SDK}/platform-tools/adb" ]; then
  echo "  ERROR: Android SDK not found at ${ANDROID_SDK}" >&2
  echo "  Set ANDROID_SDK in this script" >&2
  exit 1
fi
echo "  Android SDK platform-tools found  ✓"

# --- Export environment for Gradle ---
export JAVA_HOME="${JDK_PATH}"
export ANDROID_HOME="${ANDROID_SDK}"
export ANDROID_SDK_ROOT="${ANDROID_SDK}"
export PATH="${JDK_PATH}/bin:${ANDROID_SDK}/cmdline-tools/latest/bin:${ANDROID_SDK}/platform-tools:${HOME}/.npm-global/bin:${HOME}/bin:${PATH}"

cd "$REPO_DIR"

# --- Optional: clean gradle caches ---
if [ "$CLEAN" = "1" ]; then
  echo ""
  echo "[clean] Removing android/app/build, android/build, android/.gradle..."
  rm -rf android/app/build android/build android/.gradle 2>/dev/null || true
  echo "  done"
fi

# --- Step 1: Update version in app.json ---
echo ""
echo "[1/6] Updating app.json to version ${VERSION}..."
node -e "
  const fs = require('fs');
  const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  app.expo.version = '${VERSION}';
  fs.writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
  console.log('  app.json: ' + app.expo.version);
"

# --- Step 2: npm install ---
echo ""
echo "[2/6] Installing npm dependencies..."
npm install --no-audit --no-fund 2>&1 | tail -3

# --- Step 3: Build APK locally with Gradle ---
echo ""
echo "[3/6] Building APK with Gradle (3-5 minutes)..."
echo "  Using JDK: ${JAVA_HOME}"
echo "  Using SDK: ${ANDROID_HOME}"
echo "  (Full gradle output below -- this is the slow part)"
echo "  ----"

cd "$REPO_DIR/android"
# Run gradle directly (gradlew is a bash script; works fine in WSL)
# assembleRelease is the production APK; uses the debug keystore by default
# (matches what EAS did for the previous v3.0.12 release)
./gradlew assembleRelease --no-daemon 2>&1 | tee /tmp/gradle-build.log | tail -80
GRADLE_EXIT=${PIPESTATUS[0]}
cd "$REPO_DIR"

if [ "$GRADLE_EXIT" -ne 0 ]; then
  echo ""
  echo "ERROR: gradle build failed with exit code ${GRADLE_EXIT}" >&2
  exit 1
fi

# --- Step 4: Locate and copy the APK ---
echo ""
echo "[4/6] Locating built APK..."
APK_BUILT="android/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK_BUILT" ]; then
  echo "  app-release.apk not found, searching for any APK..." >&2
  FOUND_APK="$(find android/app/build/outputs -name "*.apk" -type f 2>/dev/null | head -1)"
  if [ -z "$FOUND_APK" ]; then
    echo "  ERROR: no APK found in android/app/build/outputs/" >&2
    exit 1
  fi
  APK_BUILT="$FOUND_APK"
  echo "  Found: $APK_BUILT"
fi

cp "$APK_BUILT" "$REPO_DIR/$APK_OUTPUT"
APK_SIZE="$(du -h "$APK_OUTPUT" | cut -f1)"
echo "  APK built: ${APK_OUTPUT} (${APK_SIZE})  ✓"

if [ "$BUILD_ONLY" = "1" ]; then
  echo ""
  echo "=========================================="
  echo "  Build complete (--build-only)"
  echo "  APK: ${REPO_DIR}/${APK_OUTPUT}"
  echo "=========================================="
  exit 0
fi

# --- Step 5: Commit and push ---
echo ""
echo "[5/6] Committing version bump and pushing to ${BRANCH}..."
git add app.json
if git commit -m "Bump version to ${VERSION}" 2>&1 | head -3; then
  echo "  Committed"
else
  echo "  (no changes to commit or commit failed, continuing)"
fi
if git push origin "${BRANCH}" 2>&1 | head -5; then
  echo "  Pushed to origin/${BRANCH}  ✓"
else
  echo "  Push failed (continuing anyway - APK is built)" >&2
fi

# --- Step 6: GitHub release ---
echo ""
echo "[6/6] Creating GitHub release ${TAG}..."

if [ ! -x "$GH" ] && ! command -v gh >/dev/null 2>&1; then
  echo "  gh not found on PATH - skipping release"
  echo "  Install: https://cli.github.com/"
  echo "  Then run:"
  echo "    gh release create ${TAG} ${APK_OUTPUT} --repo ${REPO} --title '${APP_NAME} ${TAG}' --generate-notes --latest"
  exit 0
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "  Release ${TAG} already exists, uploading APK only..."
  gh release upload "$TAG" "$APK_OUTPUT" --repo "$REPO" --clobber
else
  NOTES="$(cat <<EOF
## ${APP_NAME} ${TAG}

YouTube channel watcher widget for Android.

### What's new in v3

- Channel-first storage and server-side push notifications via WebSub
- FCM push delivery (no more 30-min polling)
- Improved widget with live state
- Configurable nag intervals (chill / relentless)

### Pre-seeded channels
- @mattdoesartandstuff
- @DNDrebeccaAFTG

### Installation
1. Download \`${APK_OUTPUT}\` below
2. Transfer to your Android device (or download directly on phone)
3. Enable 'Install from Unknown Sources' if prompted
4. Install and open
5. Long-press home screen - Widgets - TubePulse to add widget
EOF
)"
  gh release create "$TAG" "$APK_OUTPUT" \
    --repo "$REPO" \
    --title "${APP_NAME} ${TAG}" \
    --notes "$NOTES" \
    --latest
fi

echo ""
echo "=========================================="
echo "  Release created!"
echo "  https://github.com/${REPO}/releases/tag/${TAG}"
echo "=========================================="
