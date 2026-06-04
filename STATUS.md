# TubePulse — Project Status

**Last updated:** 2026-06-04
**Current version:** 3.1.6 (released, APK on GitHub)
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)
**Branch:** `master`

---

## Current State

### ✅ Deployed & Shipping
- **API Worker** — `tubepulse-api`, last deployed version `68dbc17c` (2026-06-03 19:42 UTC)
  - Endpoints live: `/register`, `/subscribe-channel`, `/unsubscribe`, `/seen`, `/feed`, `/resolve`, `/bootstrap`, `/settings`, `/channel-override`, `/websub` (dormant)
  - **Note:** the API worker has no public HTTP route (`routes = []` in `wrangler.toml`). It runs only when invoked by the cron worker (e.g. via service binding) or via direct `wrangler dev` / curl from a Cloudflare account context. The `https://tubepulse-api.jimothyoakley55.workers.dev/` URL listed in older docs responds 1042 (no such host) and is **not** a live endpoint.
- **Cron Worker** — `tubepulse-cron`, last deployed version `c08a74d1` (2026-06-04 08:23 UTC)
  - Schedule: `*/5 * * * *`
  - **Six jobs:** upcoming-events drain, prewarn, RSS poll, community posts, nag cycle, WebSub lease renewal (dormant)
- **KV namespace:** `52e77ca9f5f6493e89d2478c8d3055ec` (account `77bb7769185bbfeb53feef16b9f72803`)
- **App:** v3.1.x API client + v3.1 widget + v3.1 screens, all wired and shipping as v3.1.6
- **Release pipeline:** `build-and-release.sh` builds APK locally with Gradle, commits, pushes, and creates a GitHub release
- **Latest release:** [v3.1.6](https://github.com/Undert0e-505/TubePulse/releases/tag/v3.1.6) — 2026-06-04 09:41 UTC

### WebSub Status: Dormant
- Google's `pubsubhubbub.appspot.com` hub was **shut down in 2024**
- The WebSub handler in both workers is intact but neither worker initiates new subscriptions or renews leases
- `/websub` endpoints remain for manual testing and as a clean integration point if/when a YouTube-compatible hub reappears
- **Active video detection path:** the cron runs a YouTube **RSS feed** poller every 5 min, which reads `https://www.youtube.com/feeds/videos.xml?channel_id=...` for each channel and detects new entries by `lastVideoId` drift. RSS includes views via `media:statistics/@_views` and likes via `media:starRating/@_count` (dislikes via `media:statistics/@_dislikes`), so no extra API call is needed.

### YouTube Data API Status: Subscribe-time + hourly posts
- The YouTube Data API is used for:
  - `/resolve` (handle → channelId + name + avatar) — 1 unit, cached 7 days per handle
  - `/subscribe-channel` (avatar fetch if `meta.avatarUrl` is missing) — 1 unit per new channel, cached forever in `channel:{id}:meta`
  - **v3.1** `runCommunityPostsCron` — `activities.list` for each active channel, once per hour. ~96 units/day for 4 channels.
- After subscribe, the channel meta is cached in KV and the RSS cron never touches the Data API again
- **Quota cost: ~2 units per new channel added, then 0 units for videos forever, plus ~24 units/channel/day for posts polling**

### FCM Status: Working ✅
- Firebase service account key (1217-byte PKCS8) verified working
- Pushed to both `tubepulse-api` and `tubepulse-cron` secret managers via `secrets/set-worker-secrets.sh`
- JWT signing + token exchange verified locally: `200 OK`, 1024-char access token returned
- All FCM code paths (PKCS8 base64 padding fix, `\n` escape handling) shipped in v3.0.13
- v3.0.18: dead-token detection added — FCM `UNREGISTERED` triggers `cleanupDeadDevice`
- Push delivery: verified end-to-end on real device (v3.0.18+)

### Local Secrets Inventory
- `secrets/fcm-service-account.json` — Firebase service account, **1217 bytes (valid)**
- `secrets/cloudflare.env` — Cloudflare account credentials for `wrangler` CLI
- `secrets/youtube.env` — YouTube Data API key
- `secrets/set-worker-secrets.sh` — idempotent push script (re-runnable)
- `secrets/load-secrets.sh` — sources env + generates per-worker `.dev.vars`
- `secrets/README.md` — operator documentation
- All gitignored under `secrets/`

---

## v3.1 Architecture (as shipped)

v3.1 is a strict superset of v3.0.6 (channel-first, zero `KV.list()`). The base architecture is unchanged; v3.1 adds three new features and one UI replacement:

### v3.1 additions
1. **Likes + dislikes in the video card meta row** — parsed from `media:starRating` and `media:statistics` in RSS, throttled same as view counts (latest video only, hourly, 5% threshold for views / any-change for likes).
2. **Community posts in the feed** — new cron job `runCommunityPostsCron` polls `activities.list` hourly per channel. Stored in `channel:{id}:recent:posts`. Per-channel and global opt-out. Posts do not enter the nag cycle.
3. **Prewarn for scheduled livestreams** — new cron job `runPrewarnCron` fires per-device "going live soon" pushes at the user's chosen offset (default 1h, options 15m / 30m / 1h / 2h / 4h / 1d). The prewarn is the heads-up; the regular new-video push at live time is the "this just appeared" notification.
4. **Custom ConfirmDialog** — replaces native `Alert.alert` for destructive actions. New `src/components/ConfirmDialog.js` and `src/components/Confirm.js` (promise-based `confirm({...})` helper).

### KV key schema (v3.1, superset of v3.0)
| Key pattern | Contents | Notes |
|---|---|---|
| `channel:{channelId}:meta` | name, avatarUrl, lastVideoId, addedAt | |
| `channel:{channelId}:subscribers` | `[deviceId, ...]` | |
| `channel:{channelId}:websub` | leaseExpiresAt, hmacSecret, lastVerified | **Dormant** |
| `channel:{channelId}:recent` | last 15 videos: videoId, title, publishedAt, type, thumbnail, link, **views** + **likes** + **dislikes** | v3.1: likes/dislikes added |
| `channel:{channelId}:recent:posts` | last 30 community posts: activityId, kind, text, thumbnail, link, publishedAt | **v3.1** |
| `channel:{channelId}:firstPollAt:posts` | ISO timestamp of first posts-cron run (drives the first-run guard) | **v3.1** |
| `device:{deviceId}:profile` | fcmToken, platform, appVersion, createdAt, lastSeenAt | |
| `device:{deviceId}:settings` | mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, dndBypass, tapAction, includeCommunityPosts (v3.1), prewarnMinutes (v3.1) | |
| `device:{deviceId}:channels` | `[channelId, ...]` | |
| `device:{deviceId}:override:{channelId}` | per-channel override: mode?, nagInterval?, dndBypass?, muted?, includeCommunityPosts? (v3.1, tri-state null/true/false), prewarnMinutes? (v3.1, tri-state null/number) | |
| `device:{deviceId}:state:{channelId}` | per-device per-channel state: unwatched[] (videos by videoId, posts by `post:{activityId}`), lastNagAt, nagCount | v3.1: post IDs share the array via `post:` namespace |
| `upcoming:events:list` | `[ {channelId, videoId, scheduledFor, addedAt}, ... ]` | **v3.1** — replaced pre-v3.1 `upcoming:{bucket}` |
| `upcoming:prewarn:{videoId}:{deviceId}` | `prewarnMinutes` value, sentinel for "prewarn sent" | **v3.1** |
| `upcoming:{bucket}` | pre-v3.1 entries | **Drained** on first v3.1 tick via `runUpcomingCron` |
| `nag:{bucket}` | nag entries for a 15-min window | |
| `channels:active` | index of channels with ≥1 subscriber | |
| `handle:{lowercase}` | cached handle→channelId (7-day TTL) | |
| `fcm:lookup:{fcmToken}` | `deviceId` — reverse index for cross-version deviceId migration | v3.0.19+ |

### Time-bucket cron jobs (v3.1)
- `*/5` — upcoming-events drain (clears stale pre-v3.1 bucket entries)
- `*/5` — prewarn (per-device offset before scheduled livestreams)
- `*/5` — YouTube RSS poll (active video detection)
- `*/15` — nag cycle (chill 4h nudges, relentless re-nag)
- `0 *` — community posts (`runCommunityPostsCron`, hourly)
- `0 */6` — WebSub lease renewal (no-op, hub defunct)

### Notification flow (v3.1)
```
YouTube publishes video                       Channel posts on YouTube
        │                                              │
        ▼                                              ▼
Cron Worker polls YouTube RSS feed every 5 min  Cron Worker polls YouTube
(via https://www.youtube.com/feeds/videos.xml)   activities.list every hour
        │                                              │
        ▼                                              ▼
Diff against channel:{id}:recent → new videoIds  Diff against channel:{id}:recent:posts
        │                                              │
        ├─ type: 'live_scheduled' (future)?           │
        │   → append to upcoming:events:list          │
        │   → runPrewarnCron fires per-device         │
        │     prewarn pushes when window opens        │
        │                                              │
        ▼                                              ▼
For each new video, look up channel:{id}:subscribers, FCM fan-out
        │                                              │
        ├─ DND active for this device?                 │
        │   → livestreams bypass DND by default        │
        │   → posts and prewarn: skip (no override)    │
        │                                              │
        ▼                                              ▼
Device receives notification
        │
        ├─ User taps (video) → mark seen, open video
        ├─ User taps (channel) → clear all, open channel
        ├─ User taps (post) → mark post seen, open community tab
        ├─ User taps (prewarn) → open YouTube watch URL
        │   (video NOT marked seen — prewarn is a reminder)
        │
        ├─ User ignores → nag cycle re-notifies (videos only)
        │                  posts do NOT enter the nag cycle
        ▼
Repeat until user watches
```

---

## Recent Changes (v3.1.0 → v3.1.6)

### v3.1.6 — 2026-06-04
- Tighten thumb-count gap in the video card meta row (was too wide in 3.1.5)

### v3.1.5 — 2026-06-04
- Breathing room between thumb icon and like count

### v3.1.4 — 2026-06-04
- Fix unseen-videos filter — use the server's `unwatched` flag as source of truth (was computing client-side, drifted from server)

### v3.1.3 — 2026-06-04
- Tone down thumb icons, fix leading dots, show 0 likes by default

### v3.1.2 — 2026-06-03
- YouTube-style outline thumb icons (white wireframe instead of yellow Android)
- Fix `formatViews` to return just the number (was "919 views" — drop the word)
- Rename "Prewarn time" → "Live stream prewarn time" for context
- Tighten prewarn picker row to avoid overwriting the "Content types" heading

### v3.1.1 — 2026-06-03
- Bug fix: API worker `getFeedPostsForChannel` was missing `env` parameter (referenced `env.TUBEPULSE_KV` inside, threw `ReferenceError` on every `/feed` call after the v3.1 deploy). Fixed.
- Bug fix: cron `parseRSSFeed` now extracts likes/dislikes and writes them into `channel:{id}:recent` (the v3.1.0 commit `216ae0d` only modified the API's WebSub path; the cron's RSS path was the actual hot path for new-video detection and never had likes/dislikes). Backfill happens within an hour of deploy.
- Bug fix: `ChannelsScreen.removeChannel` now uses the new `ConfirmDialog` (was still calling `Alert.alert` in v3.1.0). `App.js` mounts `<ConfirmHost />` so the dialog can render.

### v3.1.0 — 2026-06-03
- Likes + dislikes in the video card meta row
- Community posts in the home feed (per-channel and global opt-out)
- Prewarn time for scheduled livestreams (per-channel and global)
- Custom ConfirmDialog replacing `Alert.alert` for destructive actions

### v3.0.18 → v3.0.20 — 2026-06-02 to 2026-06-03
- v3.0.18: dead-device cleanup on FCM `UNREGISTERED`, fix unsubscribe meta/recent leak
- v3.0.19: deviceId migration — use `Application.getAndroidId()` instead of random UUID, server-side migration via `fcm:lookup` index
- v3.0.20: deviceId migration — use `expo-secure-store` UUID (encrypted, hardware-backed, wiped on uninstall)

### v3.0.0 → v3.0.13 — 2026-04-20 → 2026-06-02
- Channel-first architecture migration
- FCM JWT signing fix (PKCS8 padding + `\n` escape)
- Widget auth fix, DND timezone support, fresh-install bootstrap, settings field naming, build script rewrite
- Cron reverted to RSS-based new-video detection (v3.0.18)

---

## Cloudflare Free Tier (current observed usage)

| Resource | Limit | Actual (v3.1.x) |
|----------|-------|------------------|
| KV reads | 100,000/day | ~3,000/day |
| KV writes | 1,000/day | ~200/day (new videos + throttled engagement metrics) |
| KV list ops | 1,000/day | **0** (channels:active index; one `kv.list` per `/register` for migration fallback — negligible) |
| KV storage | 1 GB | < 1 MB |
| Worker requests | 100,000/day | ~300/day (cron = 288 scheduled + a few API invocations via service binding) |
| Worker CPU time | 10 ms per invocation | < 5 ms |
| YouTube Data API | 10,000 units/day | ~100 units/day (~2 per new channel, plus ~24/channel/day for posts polling) |

---

## Next Steps

### Immediate
- [ ] Phone-test v3.1.6: confirm thumb-icon styling, like-count spacing, unseen-dot behavior
- [ ] Decide whether to deploy API worker `a4cc838` → latest (cron already deployed; API is one commit ahead of deployed)

### Short-term
- [ ] Shorts filtering (currently treated as regular uploads; detect via `media:community/media:thumbnail` height or via Data API `contentDetails.duration`)
- [ ] Privacy policy for Play Store submission
- [ ] Real FCM `UNREGISTERED` test — install APK, capture FCM token, kill token via FCM `tokens:batchDelete`, trigger a WebSub push, verify `cleanupDeadDevice` runs

### Medium-term
- [ ] Observability: `metrics:{YYYY-MM-DD}` key, daily Telegram summary
- [ ] Cloudflare email alert at 80% of any KV limit
- [ ] Posts in the nag cycle (currently only the initial push fires) — flagged for v3.2

### Future
- [ ] iOS support (APNs integration)
- [ ] Cross-device sync (optional Google sign-in)
- [ ] WebSub revival: if/when a YouTube-compatible hub reappears, re-enable lease renewal and add a push-handler health check

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v2.1.0 | 2026-04-18 | WebSub push architecture, UUID auth, HMAC verification |
| v2.2.0 | 2026-04-18 | DND batching, per-channel notification overrides |
| v2.3.0 | 2026-04-19 | Default notification mode → chill, comprehensive README |
| v2.4.3 | 2026-04-19 | Batch nag state fix, notification dedup, /seen state clearing, bootstrap fixes |
| v3.0.0 | 2026-04-20 | **Channel-first architecture** migration: zero KV.list(), time buckets, split device keys, per-channel endpoints |
| v3.0.0 → v3.0.13 | 2026-04-20 → 2026-06-02 | Bug-fix patch series: FCM JWT signing, widget auth, DND timezone, fresh-install bootstrap, settings field naming, build script rewrite |
| v3.0.18 | 2026-06-02 | **Cron reverted to RSS-based new-video detection.** Dead-device cleanup on FCM `UNREGISTERED`. |
| v3.0.19 | 2026-06-03 | deviceId = Android `Application.getAndroidId()` (was random UUID). Server-side migration via `fcm:lookup` index. |
| v3.0.20 | 2026-06-03 | deviceId = `expo-secure-store` UUID (encrypted, hardware-backed). |
| v3.1.0 | 2026-06-03 | Likes/dislikes, community posts, prewarn, ConfirmDialog. |
| v3.1.1 | 2026-06-03 | API `getFeedPostsForChannel` env bug fix; cron RSS path wires likes/dislikes; ConfirmDialog wired into ChannelsScreen. |
| v3.1.2 | 2026-06-03 | YouTube-style outline thumb icons, "views" word removed from meta, prewarn label renamed, prewarn picker tightened. |
| v3.1.3 | 2026-06-04 | Tone down thumb icons, fix leading dots, show 0 likes by default. |
| v3.1.4 | 2026-06-04 | Unseen-videos filter: use server's `unwatched` flag. |
| v3.1.5 | 2026-06-04 | Breathing room between thumb icon and like count. |
| v3.1.6 | 2026-06-04 | Tighten thumb-count gap (was too wide in 3.1.5). |
