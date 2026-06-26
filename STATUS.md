# TubePulse - Project Status

**Last updated:** 2026-06-25
**Current repo branch:** `master`
**Current app version in repo:** `3.2.4`
**Android versionCode/versionName in repo:** `324` / `3.2.4`
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)

This is the current source-of-truth status document for repo work. For detailed backend design, see [ARCHITECTURE.md](ARCHITECTURE.md), [worker/README.md](worker/README.md), and the active worker contract inventory in [worker/CONTRACTS.md](worker/CONTRACTS.md). For app release process and cleanup guidance, see [RELEASE.md](RELEASE.md). [MIGRATION_PLAN.md](MIGRATION_PLAN.md) and [PLAN_v3.1.md](PLAN_v3.1.md) are historical/planning records unless this file explicitly says otherwise.

---

## Current Repo State

Repo evidence as of this document update:

| Area | Current evidence |
|---|---|
| App version | `app.json` has `expo.version = 3.2.4` |
| Android version | `android/app/build.gradle` has `versionCode 324`, `versionName "3.2.4"` |
| API base URL | `src/utils/api.js` points to `https://tubepulse-api.jimothyoakley55.workers.dev`; live `GET /` verified reachable on 2026-06-25 |
| Release script | `build-and-release.ps1` is the current local release path |
| API worker config | `worker/tubepulse-api/wrangler.toml` defines worker `tubepulse-api`, KV namespace `52e77ca9f5f6493e89d2478c8d3055ec`; its route comment is stale/incomplete because live `workers.dev` is reachable |
| Cron worker config | `worker/tubepulse-cron/wrangler.toml` defines worker `tubepulse-cron`, the same KV namespace, and cron `*/5 * * * *` |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` preserves the old `tubepulse-resolver` source/config for reference only |

Live route verification on 2026-06-25 confirmed Cloudflare serves the app-facing API at `https://tubepulse-api.jimothyoakley55.workers.dev/`. Old notes claiming the `workers.dev` API route is unreachable are stale.

---

## Worker Deployment Status

Last worker deploy recorded: 2026-06-25.

| Worker | Deployment state |
|---|---|
| `tubepulse-cron` | Deployed on 2026-06-25 at `2026-06-25T14:04:54.907Z` to Cloudflare account `77bb7769185bbfeb53feef16b9f72803`; worker version ID `7b2900aa-6c8b-4116-a3e6-56d53d1004e1`; upload `40.07 KiB` / gzip `9.65 KiB`; binding `TUBEPULSE_KV` namespace `52e77ca9f5f6493e89d2478c8d3055ec`; trigger `*/5 * * * *`. This deploy included the cron-only runtime fixes for normalized FCM notification payloads and aligned cron cleanup helper key deletion. |
| `tubepulse-api` | Not deployed as part of the 2026-06-25 cron worker deployment. |
| `worker/archive/tubepulse-resolver` | Not deployed; archive remains reference-only. |

The app release/version remains unchanged at `3.2.4` with Android `versionCode 324`. Worker deployment is separate from app APK release; the cron deploy did not create an app release, bump versions, or publish a GitHub Release.

Community-post worker/app support exists in the repo, but runtime community-post polling and `/feed` post rows are gated by `TUBEPULSE_ENABLE_COMMUNITY_POSTS`. The gate is disabled by default when the environment variable is missing or any value other than `1`, `true`, or `yes`. Future v2 testing is additionally scoped by `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST`, where missing or blank means no channels are eligible. This keeps current workers deployable without re-enabling community-post polling or serving stale post rows until the contract is deliberately re-enabled for allowlisted channels.

---
## Active Components

| Component | Path | Current role |
|---|---|---|
| React Native / Expo app | `App.js`, `src/`, `app.json` | Android app UI, FCM registration/handling, widget integration, local cache/settings |
| Native Android project | `android/` | Expo prebuild/native Android support, widget receiver/resources, release APK build target |
| Release script | `build-and-release.ps1` | Windows-native local APK build/sign/copy, version bump, commit/push, GitHub release creation/upload |
| API worker | `worker/tubepulse-api/` | App-facing HTTP API worker in source: register, subscribe/unsubscribe, feed, resolve, bootstrap, settings, seen, dormant WebSub endpoints |
| Cron worker | `worker/tubepulse-cron/` | Scheduled/background worker: RSS polling, nag/prewarn/background jobs, FCM fan-out paths, shared KV state |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` | Historical standalone resolver worker (`tubepulse-resolver`), superseded by `worker/tubepulse-api` `/resolve`; reference only |

---

## Verified API Route State

Last verified: 2026-06-25.

The app-facing API route is currently reachable at:

`https://tubepulse-api.jimothyoakley55.workers.dev`

Safe read-only checks showed:

- `GET /` returned `200 OK` from Cloudflare with JSON body `{"status":"ok","version":"3.0.0","worker":"tubepulse-api","architecture":"channel-first"}`.
- `GET /__route_probe_readonly__` returned `404 Not Found` from Cloudflare, proving the hostname routes to a worker even for unknown paths.

Keep these version labels distinct:

- App/release version evidence in this repo is `3.2.4` with Android `versionCode 324`.
- API worker health response reports `version: "3.0.0"`; this appears to be a stale or independently versioned health label, not the app release version.

`worker/tubepulse-api/wrangler.toml` still has a comment saying "No HTTP routes" and no explicit `routes` or `workers_dev` setting. That comment/config is incomplete relative to live Cloudflare behavior. Do not change route/app config or delete worker files until the deployed Cloudflare settings are intentionally reviewed.

---

## Current Release Process

The current repo release path is `build-and-release.ps1`.

Summary behavior from the script:

1. Bump `app.json` and `android/app/build.gradle` to the requested version.
2. Run `npm install --no-audit --no-fund`.
3. Build Android release APK with `android\gradlew.bat assembleRelease --no-daemon`.
4. Sign the APK using `android/app/debug.keystore`.
5. Copy the APK to repo root as `TubePulse-vX.Y.Z.apk`.
6. For full releases, guard against untracked non-ignored files, then `git add -A`, commit, push current branch, create/update GitHub release through the GitHub API, and upload the APK.

`build-and-release.sh` is not the current release path in this repo.

Known risks and the intended safer target flow are documented in [RELEASE.md](RELEASE.md). App APK releases and Cloudflare Worker deployments are separate processes.

---

## Current Backend Summary

- Video detection is cron-driven via YouTube RSS polling.
- YouTube Data API usage is intended for handle/channel resolution and avatar/bootstrap fallback paths. Community-post v2 cron polling now uses the isolated InnerTube latest-post helper, but remains inert unless the global community-post gate is enabled and `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` contains active channel IDs in the deployed worker environment.
- API and cron workers share the same KV namespace according to their wrangler configs.
- WebSub code remains present but should be treated as dormant unless live verification proves otherwise.
- KV schema and helper logic are duplicated between worker files and have known drift; see [worker/CONTRACTS.md](worker/CONTRACTS.md) before changing worker behavior.

---

## Documentation Authority

Use these docs this way:

| Document | Status |
|---|---|
| `STATUS.md` | Current repo status and operational caveats |
| `README.md` | Product overview, project map, common commands |
| `RELEASE.md` | Current app release process, risks, and target cleanup flow |
| `ARCHITECTURE.md` | Architecture reference; may still contain historical diagrams/sections |
| `worker/README.md` | Backend/worker reference; route claims require live verification where noted |
| `MIGRATION_PLAN.md` | Historical migration record |
| `PLAN_v3.1.md` | Historical v3.1 planning/release record |

---

## Remaining Documentation Concerns

- `worker/tubepulse-api/wrangler.toml` still contains a stale/incomplete route comment; live `workers.dev` route is verified reachable, but the repo config does not explain why.
- Several older docs still contain historical v3.1/v3.0 detail that may be useful but should not override this status document.
- Some markdown files contain encoding artifacts in old prose/diagrams. This pass did not rewrite all historical content.
