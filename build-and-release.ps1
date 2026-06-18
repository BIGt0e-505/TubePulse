# ============================================================
# TubePulse -- Local APK Build & GitHub Release (Windows-native)
# ============================================================
# Uses the Android SDK and JDK installed on Windows.
# No WSL, no EAS, no cloud build.
# Just gradlew.bat calling Windows binaries.
#
# Usage:
#   .\build-and-release.ps1 -Version 3.1.7                       # build only, current branch
#   .\build-and-release.ps1 -Version 3.1.7 -Branch master       # build + commit + push + gh release
#   .\build-and-release.ps1 -Version 3.1.7 -BuildOnly           # skip git push + gh release
#   .\build-and-release.ps1 -Version 3.1.7 -Clean               # nuke gradle cache first
#   .\build-and-release.ps1 -Version 3.1.7 -Branch master -Clean # full clean + build + release
#
# Requirements (all on this Windows host):
#   - JDK 21 at C:\Program Files\Java\jdk-21
#   - Android SDK at D:\dev\android-sdk (build-tools 35/36, platform android-36, NDK 27.1.12297006)
#   - GitHub CLI (gh) on PATH for the release step (optional with -BuildOnly)
# ============================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Branch = "",

    [switch]$BuildOnly,

    [switch]$Clean
)

# --- Constants ---
$APP_NAME = "TubePulse"
$REPO = "Undert0e-505/TubePulse"
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path }
$REPO_DIR = $SCRIPT_DIR

# Android SDK + JDK (Windows-native paths)
$JDK_PATH = "C:\Program Files\Java\jdk-21"
$ANDROID_SDK = "D:\dev\android-sdk"

# --- Parse branch ---
if ([string]::IsNullOrEmpty($Branch)) {
    $Branch = (git rev-parse --abbrev-ref HEAD 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not determine current branch. Specify -Branch."
        exit 1
    }
}

$TAG = "v$Version"
$APK_OUTPUT = "$APP_NAME-$TAG.apk"

# --- Banner ---
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $APP_NAME - Build and Release $TAG" -ForegroundColor Cyan
Write-Host "  Branch: $Branch" -ForegroundColor Cyan
Write-Host "  Android SDK: $ANDROID_SDK" -ForegroundColor Cyan
Write-Host "  JDK: $JDK_PATH" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# --- Verify tools ---
Write-Host "[0/6] Verifying build tools..."

if (-not (Test-Path "$JDK_PATH\bin\java.exe")) {
    Write-Error "java not found at $JDK_PATH\bin\java.exe"
    Write-Host "  Install JDK 17 or 21 and update `$JDK_PATH in this script." -ForegroundColor Red
    exit 1
}
$javaVersion = & "$JDK_PATH\bin\java.exe" -version 2>&1 | Select-Object -First 1
Write-Host "  $javaVersion  ✓" -ForegroundColor Green

if (-not (Test-Path "$ANDROID_SDK\platform-tools\adb.exe")) {
    Write-Error "Android SDK not found at $ANDROID_SDK"
    Write-Host "  Set `$ANDROID_SDK in this script." -ForegroundColor Red
    exit 1
}
Write-Host "  Android SDK platform-tools found  ✓" -ForegroundColor Green

if (-not (Test-Path "$ANDROID_SDK\build-tools")) {
    Write-Error "Android SDK build-tools not found at $ANDROID_SDK\build-tools"
    exit 1
}
$buildTools = Get-ChildItem "$ANDROID_SDK\build-tools" -Directory | Select-Object -ExpandProperty Name
Write-Host "  Build tools: $($buildTools -join ', ')  ✓" -ForegroundColor Green

if (-not (Test-Path "$ANDROID_SDK\ndk\27.1.12297006")) {
    Write-Warning "NDK 27.1.12297006 not found at $ANDROID_SDK\ndk\27.1.12297006"
    Write-Host "  RN 0.81 requires this NDK version. Build may fail." -ForegroundColor Yellow
} else {
    Write-Host "  NDK 27.1.12297006 found  ✓" -ForegroundColor Green
}

# --- Set environment for Gradle ---
$env:JAVA_HOME = $JDK_PATH
$env:ANDROID_HOME = $ANDROID_SDK
$env:ANDROID_SDK_ROOT = $ANDROID_SDK
$env:PATH = "$JDK_PATH\bin;$ANDROID_SDK\cmdline-tools\latest\bin;$ANDROID_SDK\platform-tools;$env:PATH"

Set-Location "$REPO_DIR"

# --- Optional: clean gradle caches ---
if ($Clean) {
    Write-Host ""
    Write-Host "[clean] Removing android\app\build, android\build, android\.gradle..."
    Remove-Item -Recurse -Force "android\app\build", "android\build", "android\.gradle" -ErrorAction SilentlyContinue
    Write-Host "  done"
}

# --- Step 1: Update version in app.json and build.gradle ---
Write-Host ""
Write-Host "[1/6] Updating app.json and build.gradle to version $Version..."

# app.json
$appJsonPath = "$REPO_DIR\app.json"
$appJson = Get-Content $appJsonPath -Raw | ConvertFrom-Json
$appJson.expo.version = $Version
$appJson | ConvertTo-Json -Depth 10 | Set-Content $appJsonPath -Encoding UTF8
Write-Host "  app.json: $($appJson.expo.version)  ✓" -ForegroundColor Green

# build.gradle — derive versionCode from version (strip dots)
# e.g. 3.1.7 -> 317, 3.0.20 -> 320
$buildGradlePath = "$REPO_DIR\android\app\build.gradle"
$buildGradle = Get-Content $buildGradlePath -Raw
$versionCode = $Version -replace '\.', ''
$buildGradle = $buildGradle -replace 'versionCode \d+', "versionCode $versionCode"
$buildGradle = $buildGradle -replace 'versionName "[^"]+"', "versionName \"$Version\""
Set-Content $buildGradlePath -Value $buildGradle -Encoding UTF8
Write-Host "  build.gradle: versionCode=$versionCode versionName=$Version  ✓" -ForegroundColor Green

# --- Step 2: npm install ---
Write-Host ""
Write-Host "[2/6] Installing npm dependencies..."
$npmOutput = npm install --no-audit --no-fund 2>&1
$npmOutput | Select-Object -Last 3
Write-Host "  npm install done  ✓" -ForegroundColor Green

# --- Step 3: Build APK locally with Gradle ---
Write-Host ""
Write-Host "[3/6] Building APK with Gradle (3-5 minutes)..."
Write-Host "  Using JDK: $env:JAVA_HOME"
Write-Host "  Using SDK: $env:ANDROID_HOME"
Write-Host "  (Full gradle output below -- this is the slow part)"
Write-Host "  ----"

Set-Location "$REPO_DIR\android"
# Run gradlew.bat (Windows-native, no WSL needed)
# assembleRelease builds the production APK
& .\gradlew.bat assembleRelease --no-daemon 2>&1 | Tee-Object -FilePath "$env:TEMP\gradle-build.log" | Select-Object -Last 80
$gradleExit = $LASTEXITCODE
Set-Location "$REPO_DIR"

if ($gradleExit -ne 0) {
    Write-Host ""
    Write-Error "gradle build failed with exit code $gradleExit"
    Write-Host "  Full log: $env:TEMP\gradle-build.log" -ForegroundColor Yellow
    exit 1
}

# --- Step 3b: Sign the APK ---
Write-Host ""
Write-Host "[3b/6] Signing APK with debug keystore..."
$apksigner = Get-ChildItem "$ANDROID_SDK\build-tools" -Recurse -Filter "apksigner.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $apksigner) {
    Write-Error "apksigner.bat not found in $ANDROID_SDK\build-tools"
    exit 1
}
$unsignedApk = "$REPO_DIR\android\app\build\outputs\apk\release\app-release.apk"
$keystore = "$REPO_DIR\android\app\debug.keystore"
if (-not (Test-Path $keystore)) {
    Write-Error "debug.keystore not found at $keystore"
    exit 1
}
& $apksigner.FullName sign --ks $keystore --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android $unsignedApk 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "apksigner failed with exit code $LASTEXITCODE"
    exit 1
}
Write-Host "  APK signed (v2/v3)  ✓" -ForegroundColor Green

# --- Step 4: Locate and copy the APK ---
Write-Host ""
Write-Host "[4/6] Locating built APK..."
$apkBuilt = "$REPO_DIR\android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $apkBuilt)) {
    Write-Host "  app-release.apk not found, searching for any APK..."
    $foundApk = Get-ChildItem "$REPO_DIR\android\app\build\outputs" -Filter "*.apk" -Recurse -File | Select-Object -First 1
    if (-not $foundApk) {
        Write-Error "no APK found in android\app\build\outputs\"
        exit 1
    }
    $apkBuilt = $foundApk.FullName
    Write-Host "  Found: $apkBuilt"
}

Copy-Item $apkBuilt "$REPO_DIR\$APK_OUTPUT" -Force
$apkSize = (Get-Item "$REPO_DIR\$APK_OUTPUT").Length / 1MB
Write-Host ("  APK built: {0} ({1:N1} MB)  ✓" -f $APK_OUTPUT, $apkSize) -ForegroundColor Green

if ($BuildOnly) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  Build complete (-BuildOnly)" -ForegroundColor Cyan
    Write-Host "  APK: $REPO_DIR\$APK_OUTPUT" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    exit 0
}

# --- Step 5: Commit and push ---
Write-Host ""
Write-Host "[5/6] Committing version bump and pushing to $Branch..."
git add app.json
$commitResult = git commit -m "Bump version to $Version" 2>&1
$commitResult | Select-Object -First 3
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Committed" -ForegroundColor Green
} else {
    Write-Host "  (no changes to commit or commit failed, continuing)"
}

$pushResult = git push origin $Branch 2>&1
$pushResult | Select-Object -First 5
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Pushed to origin/$Branch  ✓" -ForegroundColor Green
} else {
    Write-Host "  Push failed (continuing anyway - APK is built)" -ForegroundColor Yellow
}

# --- Step 6: GitHub release ---
Write-Host ""
Write-Host "[6/6] Creating GitHub release $TAG..."

$ghExe = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghExe) {
    Write-Host "  gh not found on PATH - skipping release" -ForegroundColor Yellow
    Write-Host "  Install: https://cli.github.com/"
    Write-Host "  Then run:"
    Write-Host "    gh release create $TAG $APK_OUTPUT --repo $REPO --title '$APP_NAME $TAG' --generate-notes --latest"
    exit 0
}

# Check if release already exists
$existingRelease = gh release view $TAG --repo $REPO 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Release $TAG already exists, uploading APK only..."
    gh release upload $TAG $APK_OUTPUT --repo $REPO --clobber 2>&1
} else {
    $notes = @"
## $APP_NAME $TAG

Android YouTube channel watcher with home screen widget.

### Installation
1. Download ``$APK_OUTPUT`` below
2. Transfer to your Android device (or download directly on phone)
3. Enable 'Install from Unknown Sources' if prompted
4. Install and open
5. Long-press home screen > Widgets > TubePulse to add widget
"@
    gh release create $TAG $APK_OUTPUT --repo $REPO --title "$APP_NAME $TAG" --notes $notes --latest 2>&1
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  Release created!" -ForegroundColor Cyan
    Write-Host "  https://github.com/$REPO/releases/tag/$TAG" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
} else {
    Write-Host "  Release creation failed (exit code $LASTEXITCODE)" -ForegroundColor Yellow
    Write-Host "  APK is at: $REPO_DIR\$APK_OUTPUT"
}