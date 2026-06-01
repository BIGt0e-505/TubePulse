# TubePulse — Repo State, June 2026

This document explains the current state of the repo and how to find the
v3.0 implementation, because the git history is non-obvious.

## TL;DR

| Tree | What's in it | What it is |
|---|---|---|
| **`master` (HEAD, v3.0.12)** | Polling-based RN app (v1/v2) + v3 design docs (ARCHITECTURE.md, IMPLEMENTATION.md) | The tree that **shipped** to users as v3.0.12. App does not use the v3 server. |
| **`v3-original` (from tag v3.0.2)** | Real v3 app: FCM, WebSub, channel-first storage, native android/, workers | The tree where v3 **actually worked**. The one true v3 codebase. |
| **Cloudflare** | Workers deployed from somewhere (history unclear), currently `404` on API and `500` on cron | Possibly deployed from v3.0.2 source, possibly from a local copy, not from the master tree (no worker source tracked in master). |

## What happened (best guess from git archaeology)

1. **v1.0.x → v2.4.x** (Feb–Apr 2026): polling-based RN app, working, stable
2. **v2.0.0 → v3.0.2** (April 20, 2026 morning): full v3 migration, commits `a5040ae` (Phase 3+4: FCM integration) through `5a26db9` (Fix: bootstrapChannel import)
3. **`ddba2c6`** (April 20, 11:39 AM): "Add ARCHITECTURE.md — v3.0 design spec" — this commit was created on a **different/older tree state** (parent is NOT `5a26db9`). At this commit, App.js is back to pre-v3 polling, worker/ is empty, android/ is gone
4. **v3.0.3 → v3.0.12** (April 20 PM → April 21): all "Bump version" commits stacked on the reset tree
5. **v3.0.12 APK published** (April 21): built from the reset tree, ships the polling app despite version 3.0.12

The most likely explanation: at v3.0.2, a build problem was hit (maybe EAS build failed, or the FCM integration broke something at runtime), and a quick decision was made to revert to the last-known-good v1/v2 build, bump the version to v3.0.3, and ship. The v3 docs (ARCHITECTURE, IMPLEMENTATION, this file) were kept as design intent for the next attempt.

The actual v3 source code is fully preserved on the `v3-original` branch (same as tag `v3.0.2`).

## What's tracked where

### `master` (current)
```
App.js                              ← pre-v3, polling
src/utils/{storage,rss,notifications,backgroundTask,foregroundService,constants}.js
src/screens/{Home,Channels,Settings}Screen.js
src/components/{TubePulseWidget,widgetTaskHandler,TimeSpinner}.js
android/                            ← gone since v3.0.3
worker/                             ← empty since v3.0.3
ARCHITECTURE.md                     ← v3 design (good)
IMPLEMENTATION.md                   ← v3 implementation doc (slightly out of sync with code, but mostly accurate)
README.md                           ← v3 marketing
google-services.json                ← gone since v3.0.3
```

### `v3-original` (preserved v3.0.2)
```
App.js                              ← v3 init: requestPermissionAndGetToken, registerDevice, fetchFeed, migrate v2→v3
src/utils/fcm.js                    ← @react-native-firebase/messaging wrapper
src/utils/api.js                    ← All 9 v3 endpoints wrapped
src/utils/{storage,rss,notifications}.js   ← updated for v3 (deviceId-keyed, etc.)
src/utils/{backgroundTask,foregroundService}.js  ← removed in v3
android/                            ← native MainActivity, MainApplication, TubePulseWidget.java
android/app/google-services.json    ← Firebase config
worker/                             ← 4 files (api/index.js, api/wrangler.toml, cron/index.js, cron/wrangler.toml, cron/package.json)
MIGRATION_PLAN.md                   ← v2→v3 migration notes (gone from master)
STATUS.md                           ← progress notes (gone from master)
```

## How to actually use v3

The `master` tree won't work as a v3 app — the App.js polls, doesn't register
with the server, doesn't have an FCM token. If you want a working v3:

1. **Branch from `v3-original` (v3.0.2)**: `git checkout v3-original`
2. The `android/` directory and `google-services.json` were stripped at some point — you'll need to regenerate the Firebase config and the native project. EAS Build can probably do this if you re-link the project.
3. The `worker/` source files were also deleted from v3.0.2 onwards, but I restored them to **master** in this commit (they're tracked in git again at `worker/tubepulse-api/` and `worker/tubepulse-cron/`).
4. The current Cloudflare workers appear unhealthy (`tubepulse-api` returns 404, `tubepulse-cron` returns 500). You'll need to redeploy them.

## What's in this commit

This commit restores the v3 worker source files to `master`'s working tree
so they're at least tracked in git going forward:

- `worker/tubepulse-api/index.js` (from dcc0d79, last touched)
- `worker/tubepulse-api/wrangler.toml` (from ffb1991, original v3 setup)
- `worker/tubepulse-cron/index.js` (from d6a8355, JSDoc fix)
- `worker/tubepulse-cron/wrangler.toml` (from ffb1991)
- `worker/tubepulse-cron/package.json` (from c50907f, initial)

These match the latest version in git history. The `App.js`, `src/utils/*`,
and `android/` files on master were **not** changed — they remain the v1/v2
polling app that ships in the v3.0.12 APK.
