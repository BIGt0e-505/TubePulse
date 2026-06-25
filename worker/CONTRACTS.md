# Active Worker Contracts

**Last updated:** 2026-06-25
**Status:** Current-state inventory for the active Cloudflare Workers. This document records observed contracts, coupling, and known drift. It is not a refactor plan, and it does not imply that every behavior described here is ideal.

Use this file before changing `worker/tubepulse-api/` or `worker/tubepulse-cron/`. If code changes alter endpoint behavior, KV keys, notification payloads, cron cadence, bindings, or deployment assumptions, update this contract in the same commit.

---

## Active Workers

| Worker | Path | Role | Trigger type | KV binding | KV namespace | Deployment note |
|---|---|---|---|---|---|---|
| `tubepulse-api` | `worker/tubepulse-api/` | Live app-facing REST API plus dormant WebSub callback endpoints | HTTP `fetch` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Live `workers.dev` route was verified on 2026-06-25. `GET /` identifies `worker: "tubepulse-api"`. Wrangler config has no explicit route and contains a stale/incomplete route comment. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Scheduled/background worker for RSS polling, prewarns, nags, community posts, and stale bucket drain | Cloudflare scheduled event, `*/5 * * * *` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Scheduled-only worker. No public HTTP handler is expected. |

Both active workers use `compatibility_date = "2025-04-01"` and Cloudflare account `77bb7769185bbfeb53feef16b9f72803` in their wrangler configs.

The API health endpoint currently returns `version: "3.0.0"`. App release evidence in the repo is `3.2.4` with Android `versionCode 324`. Treat these as separate labels until the worker health version is intentionally changed.

## Archived Workers

`worker/archive/tubepulse-resolver/` contains the historical standalone resolver worker. It is retained for reference only and should not be deployed or edited unless deliberately restoring historical resolver behavior.

---

## API Endpoint Inventory

| Method | Path | Purpose | Auth | KV effects | External calls | Notification side effects | Risk |
|---|---|---|---|---|---|---|---|
| `GET` | `/` | Health check. Returns `status`, `version: "3.0.0"`, `worker`, and `architecture`. | None | None | None | None | Low |
| `OPTIONS` | `*` | CORS preflight. | None | None | None | None | Low |
| `POST` | `/register` | Create/update device profile, preserve or rotate FCM token, and migrate old device IDs that share an FCM token. | `Authorization: Bearer <deviceId>` | Reads/writes `device:{id}:profile`, `fcm:lookup:{token}`, settings/channels/state during migration; deletes old device state; uses `KV.list({ prefix: 'device:' })` for slow-path migration. | None | None | High |
| `POST` | `/subscribe-channel` | Add a channel to a device, populate inverse subscriber list, bootstrap channel meta/recent data, and enqueue dormant WebSub subscription attempt on first subscriber. | Bearer deviceId | Reads/writes `device:{id}:channels`, `channel:{id}:subscribers`, `channel:{id}:meta`, `channel:{id}:recent`, `channels:active`, `channel:{id}:websub`. | YouTube Data API for channel meta when missing; YouTube RSS for recent videos; Data API fallback for recent videos; WebSub hub POST attempt. | None directly. | High |
| `POST` | `/unsubscribe` | Remove device from channel, delete per-channel device state/override, and clean channel cache if it was the last subscriber. | Bearer deviceId | Reads/writes/deletes `device:{id}:channels`, `channel:{id}:subscribers`, `device:{id}:state:{channelId}`, `device:{id}:override:{channelId}`, channel cache via cleanup. | WebSub unsubscribe POST attempt. | None | Medium |
| `POST` | `/seen` | Mark video IDs or post IDs as watched, or clear all unwatched state for one channel. | Bearer deviceId | Reads/writes `device:{id}:state:{channelId}`. Does not remove pending nag bucket entries. | None | Affects future nag eligibility. | Medium |
| `GET` | `/feed` | Return subscribed channels with meta, recent videos, community posts, and per-device unwatched flags. | Bearer deviceId | Reads `device:{id}:settings`, `device:{id}:profile`, `device:{id}:channels`, channel meta/recent/posts, overrides, and device state. | None | None | Medium |
| `GET` | `/resolve` | Resolve a `handle` or `channelId` to canonical channel info. | Bearer deviceId | Reads `device:{id}:profile`; reads/writes `handle:{lowercase}` cache. | YouTube Data API `channels.list`. | None | Medium |
| `POST` | `/bootstrap` | On-demand channel meta/recent refresh for a channel already tracked by the device. | Bearer deviceId | Reads/writes device/channel keys, `channels:active`, and `channel:{id}:websub`. | YouTube Data API, YouTube RSS, WebSub hub POST attempt. | None directly. | High |
| `POST` | `/settings` | Replace device-level notification settings. | Bearer deviceId | Writes `device:{id}:settings`. | None | Changes future notification filtering/nag/prewarn behavior. | Medium |
| `POST` | `/channel-override` | Set or delete per-channel notification override. | Bearer deviceId | Writes or deletes `device:{id}:override:{channelId}`. | None | Changes future notification filtering/nag/prewarn/community-post behavior. | Medium |
| `GET` | `/websub` | Dormant WebSub verification handshake. | None | Reads/writes/deletes `channel:{id}:websub`. | None | None | Dormant/Medium |
| `POST` | `/websub` | Dormant WebSub push processing path. Parses feed XML, writes recent/meta/state, fans out FCM, and schedules nags/prewarn events. | HMAC when matching WebSub state exists | Reads/writes channel recent/meta/subscribers, device profile/settings/override/state, nag buckets, and `upcoming:events:list`; can cleanup dead devices. | FCM; only called if a WebSub-compatible source posts to it. | Sends push notifications and can prune dead devices. | Dormant/High |

Important exception: `/register` intentionally uses `KV.list({ prefix: 'device:' })` for slow-path FCM-token migration. Documentation should not claim zero `KV.list()` calls globally. The cron worker itself is designed not to call `KV.list()`.

---

## Cron And Background Inventory

| Function | Cadence | Purpose | KV effects | External calls | FCM side effects | Risk | Notes |
|---|---|---|---|---|---|---|---|
| `runUpcomingCron` | Every 5 minutes | Drain legacy `upcoming:{bucket}` entries from the pre-v3.1 scheduled-live scheme. | Reads and deletes current `upcoming:{bucket}`. | None | None | Low | Drain-only. Does not send old live-soon/live-now pushes. |
| `runPrewarnCron` | Every 5 minutes | Iterate `upcoming:events:list` and send per-device scheduled-live prewarns when each device's window opens. | Reads/writes `upcoming:events:list`, `upcoming:prewarn:{videoId}:{deviceId}`, channel meta/subscribers, device profile/settings/override; deletes stale prewarn keys. | FCM OAuth token exchange and message send. | Sends prewarn pushes; can cleanup dead devices. | High | Current payload construction appears to use nested `notification` while cron `sendFCMPush` expects flat `title`/`body`. Documented as observed risk, not fixed. |
| `runRssPollCron` | Every 5 minutes | Active new-video detection via YouTube RSS for each `channels:active` channel. | Reads `channels:active`, channel recent/meta/subscribers, device profile/settings/override/state; writes channel recent/meta, device state, `nag:{bucket}`, `upcoming:events:list`; can cleanup dead devices. | YouTube RSS; FCM OAuth/message send. | Sends upload/live pushes; schedules nags; can prune dead devices. | High | Primary detection path. |
| `runNagCron` | Every 15 minutes | Re-notify devices about still-unwatched videos from `nag:{bucket}`. | Reads/deletes current nag bucket; reads/writes device state; reads channel meta/recent and settings/overrides; writes future nag buckets. | FCM OAuth/message send. | Sends reminder pushes; can cleanup dead devices. | High | Re-checks state so `/seen` does not need to remove bucket entries. |
| `runCommunityPostsCron` | Hourly when `minute === 0` | Poll YouTube community posts, populate first-run cache, notify opted-in devices for new posts. | Reads `channels:active`, `channel:{id}:firstPollAt:posts`, posts, subscribers, profile/settings/override/state; writes recent posts, first-poll marker, device state. | YouTube Data API `activities.list`; FCM OAuth/message send. | Sends community-post pushes; can cleanup dead devices. | High | Current payload construction appears inconsistent with cron `sendFCMPush` expectations. |
| `runLeaseCron` | Every 6 hours when `minute === 0 && hour % 6 === 0` | Calls `renewSubscriptions`. | Effectively none. | None in current implementation. | None | Low/Stale | `renewSubscriptions` is a no-op because the WebSub hub is believed defunct/dormant. |

---

## KV Schema Inventory

| Key | Owner/use | Shape or purpose | Current notes |
|---|---|---|---|
| `channel:{id}:meta` | Shared | Channel display/cache metadata such as `name`, `avatarUrl`, `lastVideoId`, `addedAt`. | Written by API bootstrap/subscribe and cron RSS updates. |
| `channel:{id}:subscribers` | Shared | JSON array of `deviceId`s subscribed to the channel. | API mutates on subscribe/unsubscribe; cron reads for fan-out and cleanup. |
| `channel:{id}:websub` | Mostly API/dormant | WebSub lease/HMAC state. | WebSub is currently dormant/stale; API can still write/read this key. |
| `channel:{id}:recent` | Shared | Recent video array. | API can bootstrap; cron is the active updater through RSS. |
| `channel:{id}:recent:posts` | Shared | Recent community posts array. | Cron writes; API `/feed` reads. |
| `channel:{id}:firstPollAt:posts` | Cron-only | ISO timestamp sentinel for community-post first-run guard. | Present in cron key builders only. |
| `device:{id}:profile` | Shared | Device profile with FCM token, platform, app version, created/last seen timestamps. | API writes; API/cron read. |
| `device:{id}:settings` | Shared | Device notification settings. | API writes full replacement; cron/API read. |
| `device:{id}:channels` | Shared | JSON array of subscribed channel IDs for the device. | API writes; API reads for `/feed`; cleanup reads. |
| `device:{id}:override:{channelId}` | Shared | Per-channel notification override. | API writes/deletes; cron/API read. |
| `device:{id}:state:{channelId}` | Shared | Per-device/channel state, including `unwatched`, `lastNagAt`, `nagCount`. | API `/seen` writes; cron/API notification paths write/read. |
| `channels:active` | Shared | JSON array of channels with at least one subscriber. | API writes on first/last subscriber; cron reads for polling. |
| `nag:{bucket}` | Shared, mostly cron | Pending nag entries for 15-minute buckets. | API WebSub path and cron can write; cron nag reads/deletes. |
| `upcoming:{bucket}` | Legacy/shared | Pre-v3.1 scheduled-live bucket. | Cron drains only; active code should not add new entries. |
| `upcoming:events:list` | Shared, mostly cron | Global list of scheduled live events. | API WebSub and cron RSS can append; cron prewarn reads/prunes. |
| `upcoming:prewarn:{videoId}:{deviceId}` | Cron-only | Sentinel that a prewarn was sent for a device/event. | Present in cron key builders only. |
| `handle:{lowercase}` | API-only | Cached handle resolution result. | API `/resolve` reads/writes. |
| `fcm:lookup:{fcmToken}` | API-only | Reverse FCM token to deviceId migration index. | Present in API key builders only; cleanup drift means cron cleanup does not currently clear it. |

---

## Known Drift And Risks

- **Key builder drift:** API has `fcmLookup`; cron has `firstPollAtPosts` and `prewarnSent`. Shared keys are duplicated manually.
- **`cleanupDeadChannel` drift:** API cleanup deletes `channel:{id}:subscribers`; cron cleanup currently does not.
- **`cleanupDeadDevice` drift:** API cleanup reads profile and deletes `fcm:lookup:{token}`; cron cleanup does not clear the FCM lookup index.
- **Duplicated `sendFCMPush`:** API and cron each define their own FCM OAuth/sign/send helper.
- **Notification payload shape compatibility:** fixed on the `worker-stabilisation` branch. Cron `sendFCMPush` now accepts the existing flat `payload.title`/`payload.body` shape and the nested `payload.notification.title`/`payload.notification.body` shape used by prewarn/community-post callers. Flat fields remain the preferred shape for new callers.
- **DND/settings logic duplication:** effective notification settings are rebuilt in API WebSub, RSS cron, nag cron, prewarn cron, and community-post logic.
- **RSS/feed parsing duplication:** API and cron parse YouTube Atom/RSS separately, with small differences in field handling.
- **Stale/dormant WebSub behavior:** WebSub subscribe/unsubscribe/push code remains, but the public PubSubHubbub hub URL is believed defunct. Do not assume WebSub is active without live verification.
- **Hardcoded API callback URL in cron:** `runLeaseCron` uses `https://tubepulse-api.jimothyoakley55.workers.dev/websub`.
- **Stale health version:** API `GET /` reports `version: "3.0.0"` while app release evidence is `3.2.4` / Android `versionCode 324`.
- **Documentation drift:** older architecture/history sections may still imply zero global `KV.list()` use, active WebSub assumptions, or older Data API polling behavior. Treat this document and `STATUS.md` as the current operational starting point.

---

## Guardrails For Future Edits

- Do not change API and cron KV keys independently without updating this contract.
- Do not modify notification payload shape without checking every `sendFCMPush` caller in both workers.
- Do not assume WebSub is active without live route and hub verification.
- Do not edit `worker/archive/tubepulse-resolver/` unless deliberately restoring historical resolver behavior.
- Prefer small commits with validation after worker changes.
- Keep worker code, wrangler config, docs, and app URL assumptions in sync when deployment behavior changes.

---

## Local Validation

Run this lightweight syntax check before and after worker behavior changes:

```bash
npm run check:workers
```

The command currently runs `node --check` against both active worker entrypoints:

- `worker/tubepulse-api/index.js`
- `worker/tubepulse-cron/index.js`

This is intentionally narrow. It catches JavaScript parse errors without deploying workers, calling live APIs, changing KV state, or requiring a test framework.

---
## Suggested Next Steps

1. Add lightweight static checks for worker syntax and contract-sensitive patterns.
2. Fix docs contradictions around `KV.list()`, branch/status wording, and dormant WebSub history.
3. Fix the cron FCM payload-shape inconsistency in a small behavior-fix commit after approval.
4. Fix cleanup-helper drift in a separate small behavior-fix commit after approval.
5. Consider shared modules only after checks exist and the current contracts are covered.