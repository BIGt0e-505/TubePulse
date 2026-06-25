# TubePulse - Project Status

**Last updated:** 2026-06-25
**Current repo branch:** `repo-hygiene`
**Current app version in repo:** `3.2.4`
**Android versionCode/versionName in repo:** `324` / `3.2.4`
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)

This is the current source-of-truth status document for repo work. For detailed backend design, see [ARCHITECTURE.md](ARCHITECTURE.md) and [worker/README.md](worker/README.md). [MIGRATION_PLAN.md](MIGRATION_PLAN.md) and [PLAN_v3.1.md](PLAN_v3.1.md) are historical/planning records unless this file explicitly says otherwise.

---

## Current Repo State

Repo evidence as of this document update:

| Area | Current evidence |
|---|---|
| App version | `app.json` has `expo.version = 3.2.4` |
| Android version | `android/app/build.gradle` has `versionCode 324`, `versionName "3.2.4"` |
| API base URL | `src/utils/api.js` points to `https://tubepulse-api.jimothyoakley55.workers.dev` |
| Release script | `build-and-release.ps1` is the current local release path |
| API worker config | `worker/tubepulse-api/wrangler.toml` defines worker `tubepulse-api`, KV namespace `52e77ca9f5f6493e89d2478c8d3055ec`, and comments saying no HTTP routes |
| Cron worker config | `worker/tubepulse-cron/wrangler.toml` defines worker `tubepulse-cron`, the same KV namespace, and cron `*/5 * * * *` |
| Legacy worker config | `worker/wrangler.toml` defines `tubepulse-resolver`, apparently legacy resolver material retained for now |

Live Cloudflare deployment state was not verified during this docs pass. Do not treat old deployment IDs, route availability claims, or `workers.dev` reachability statements in older notes as authoritative without checking Cloudflare directly.

---

## Active Components

| Component | Path | Current role |
|---|---|---|
| React Native / Expo app | `App.js`, `src/`, `app.json` | Android app UI, FCM registration/handling, widget integration, local cache/settings |
| Native Android project | `android/` | Expo prebuild/native Android support, widget receiver/resources, release APK build target |
| Release script | `build-and-release.ps1` | Windows-native local APK build/sign/copy, version bump, commit/push, GitHub release creation/upload |
| API worker | `worker/tubepulse-api/` | App-facing HTTP API worker in source: register, subscribe/unsubscribe, feed, resolve, bootstrap, settings, seen, dormant WebSub endpoints |
| Cron worker | `worker/tubepulse-cron/` | Scheduled/background worker: RSS polling, nag/prewarn/background jobs, FCM fan-out paths, shared KV state |
| Legacy resolver | `worker/index.js`, `worker/wrangler.toml` | Older standalone resolver worker (`tubepulse-resolver`); repo evidence suggests it is not the current app API |

---

## Worker Route Caveat

There is an unresolved route/deployment contradiction that must be verified before worker cleanup:

- Current app code points at `https://tubepulse-api.jimothyoakley55.workers.dev`.
- `worker/tubepulse-api/wrangler.toml` comments say "No HTTP routes" and has no active `routes` entry.
- Older docs claimed the API worker had no public route/service-binding-only access.
- The current app is reported to work reasonably well, so either the `workers.dev` route is enabled outside the repo-visible config, docs are stale, or live Cloudflare state differs from repo assumptions.

Do not delete or reroute worker files based only on repo text. Verify live Cloudflare worker settings before changing worker deployment or API URL behavior.

---

## Current Release Process

The current repo release path is `build-and-release.ps1`.

Inferred behavior from the script:

1. Bump `app.json` and `android/app/build.gradle` to the requested version.
2. Run `npm install --no-audit --no-fund`.
3. Build Android release APK with `android\gradlew.bat assembleRelease --no-daemon`.
4. Sign the APK using `android/app/debug.keystore`.
5. Copy the APK to repo root as `TubePulse-vX.Y.Z.apk`.
6. For full releases, guard against untracked non-ignored files, then `git add -A`, commit, push current branch, create/update GitHub release through the GitHub API, and upload the APK.

`build-and-release.sh` is not the current release path in this repo.

---

## Current Backend Summary

- Video detection is cron-driven via YouTube RSS polling.
- YouTube Data API usage is intended for handle/channel resolution, avatar/bootstrap fallback paths, and any current community-post polling logic present in the cron worker.
- API and cron workers share the same KV namespace according to their wrangler configs.
- WebSub code remains present but should be treated as dormant unless live verification proves otherwise.
- KV schema and helper logic are duplicated between worker files, so backend changes should be made carefully and tested against both workers.

---

## Documentation Authority

Use these docs this way:

| Document | Status |
|---|---|
| `STATUS.md` | Current repo status and operational caveats |
| `README.md` | Product overview, project map, common commands |
| `ARCHITECTURE.md` | Architecture reference; may still contain historical diagrams/sections |
| `worker/README.md` | Backend/worker reference; route claims require live verification where noted |
| `MIGRATION_PLAN.md` | Historical migration record |
| `PLAN_v3.1.md` | Historical v3.1 planning/release record |

---

## Remaining Documentation Concerns

- Live Cloudflare route state is unresolved from repo files alone.
- Several older docs still contain historical v3.1/v3.0 detail that may be useful but should not override this status document.
- Some markdown files contain encoding artifacts in old prose/diagrams. This pass did not rewrite all historical content.