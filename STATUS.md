# TubePulse — Project Status

**Last updated:** 2026-06-02
**Current version:** 3.0.13 (released, APK on GitHub)
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)
**Branch:** `v3-restored` (the active branch — `v3.0.13` release lives here)

---

## Current State

### ✅ Deployed & Shipping
- **API Worker** — `tubepulse-api` deployed at `https://tubepulse-api.jimothyoakley55.workers.dev` (version 3.0.0, channel-first architecture)
  - All endpoints live: `/register`, `/subscribe-channel`, `/unsubscribe`, `/seen`, `/feed`, `/resolve`, `/bootstrap`, `/settings`, `/channel-override`, `/websub`
- **Cron Worker** — `tubepulse-cron` deployed at `https://tubepulse-cron.jimothyoakley55.workers.dev` (schedule `*/5 * * * *`)
  - Three jobs: upcoming events, nag cycle, lease renewal (WebSub, dormant)
  - **Active video detection:** YouTube Data API polling (see below)
- **KV namespace:** `52e77ca9f5f6493e89d2478c8d3055ec` (new account, post-migration cleanup)
- **App:** v3 API client + v3 widget + v3 screens, all wired
- **Release pipeline:** `build-and-release.sh` builds APK locally with Gradle, commits, pushes, and creates a GitHub release with `--latest` flag
- **Latest release:** [v3.0.13](https://github.com/Undert0e-505/TubePulse/releases/tag/v3.0.13)

### WebSub Status: Dormant
- Google's `pubsubhubbub.appspot.com` hub was **shut down in 2024**
- The WebSub handler in both workers is intact but the cron no longer initiates new subscriptions
- Lease renewal job is a no-op
- **`/websub` endpoints** remain for manual testing and as a clean integration point if/when a YouTube-compatible hub reappears
- **Active video detection path:** the cron runs a YouTube Data API poller every 5 min (Job 2.5 in `tubepulse-cron/index.js`), which sees the full catalogue of videos per channel and detects new ones by `lastVideoId` drift

### FCM Status: Working ✅
- Firebase service account key (truncated 1216-byte PKCS8 — broken since v2) **regenerated to 1217 bytes** on 2026-06-02
- Pushed to both `tubepulse-api` and `tubepulse-cron` secret managers via `secrets/set-worker-secrets.sh`
- JWT signing + token exchange verified locally: `200 OK`, 1024-char access token returned
- All FCM code paths (PKCS8 base64 padding fix, `\n` escape handling) shipped in v3.0.13
- Pending: real-device smoke test on Android to confirm push delivery

### Local Secrets Inventory
- `secrets/fcm-service-account.json` — Firebase service account, **1217 bytes (valid)**
- `secrets/cloudflare.env` — Cloudflare account credentials for `wrangler` CLI
- `secrets/youtube.env` — YouTube Data API key
- `secrets/set-worker-secrets.sh` — idempotent push script (re-runnable)
- `secrets/load-secrets.sh` — sources env + generates per-worker `.dev.vars`
- `secrets/README.md` — operator documentation
- All gitignored under `secrets/`

---

## v3.0 Architecture (as shipped)

### Channel-first
- Channels are the unit of work, devices are the unit of subscription
- All operations ask "what's happening to this channel" first
- Inverse views maintained in KV (subscribers per channel ↔ channels per device)
- **Zero `KV.list()` calls** — replaced by the `channels:active` index for lease renewal

### KV key schema
| Key pattern | Contents |
|---|---|
| `channel:{channelId}:meta` | name, avatarUrl, lastVideoId, addedAt |
| `channel:{channelId}:subscribers` | `[deviceId, ...]` |
| `channel:{channelId}:websub` | leaseExpiresAt, hmacSecret, lastVerified (dormant) |
| `channel:{channelId}:recent` | last 15 videos: videoId, title, publishedAt, type, thumbnail, link |
| `device:{deviceId}:profile` | fcmToken, platform, appVersion, createdAt, lastSeenAt |
| `device:{deviceId}:settings` | mode, nagInterval, dndStart/End, tapAction, etc. |
| `device:{deviceId}:channels` | `[channelId, ...]` |
| `device:{deviceId}:override:{channelId}` | per-channel notification override (optional) |
| `device:{deviceId}:state:{channelId}` | per-device per-channel nag state |
| `upcoming:{bucket}` | scheduled event entries (5-min window) |
| `nag:{bucket}` | nag entries (15-min window) |
| `channels:active` | index of channels with ≥1 subscriber |
| `handle:{lowercase}` | cached handle→channelId (7-day TTL) |

### Time-bucket cron jobs
- `*/5` — upcoming events (scheduled livestream heads-up + live-now)
- `*/5` — YouTube Data API poll (active detection path)
- `*/15` — nag cycle (chill 4h nudges, relentless re-nag)
- `0 */6` — WebSub lease renewal (no-op, hub defunct)

### Notification flow (current)
```
YouTube publishes video
        ↓
Cron Worker polls channels via YouTube Data API (every 5 min)
        ↓
API Worker stores new videoId in channel:{id}:recent
        ↓
API Worker reads subscribers → for each device:
        ↓
Check DND, mode, override → FCM push if eligible
        ↓
Device receives push
        ↓
User taps → POST /seen → state cleared
        ↓
Nag cycle keeps nudging per settings until watched
```

---

## Recent Changes (v3.0.13)

### Code fixes shipped
- **FCM JWT signing** — `getGoogleAccessToken` now strips literal `\n` escapes from the PEM before base64-decoding, and pads to a 4-byte boundary. This fixes the `DataError: Invalid PKCS8 input` failure that had silently broken all push delivery since v2.
- **Widget auth** — widget now sends `deviceId` (the persistent UUID) as the Bearer token, not the FCM token. Reads `result.channels` from `/feed`, not `result.feeds`.
- **Settings update** — `api.updateSettings` auto-converts `notificationMode` → `mode` and adds `dndTimezone` before posting.
- **DND timezone** — both workers' `isDndActive` takes an IANA timezone string and resolves wall-clock time via `Intl.DateTimeFormat`.
- **DEFAULT_SETTINGS** — includes `dndTimezone: 'UTC'` as a fallback.

### Infra
- Both workers repointed to a new Cloudflare account + KV namespace
- `API_URL` in `src/utils/api.js` updated to the new subdomain
- Hardcoded cron callback URL in `tubepulse-cron/index.js` updated
- `secrets/` consolidated: README, load script, set script, .gitignore hardening

### Build & release
- `build-and-release.sh` rewritten as a WSL-native gradle build (no EAS, no PowerShell dance)
- Android SDK and JDK paths now point at the WSL install (`/home/openclaw/Android/Sdk`, `~/.local/lib/jdk-17.0.13+11`) — the Windows SDK install is stale and missing the NDK
- Single command: `./build-and-release.sh 3.0.13 v3-restored` → APK + commit + push + GitHub release

---

## Next Steps

### Immediate (smoke test)
- [ ] Install `TubePulse-v3.0.13.apk` on a real Android device
- [ ] Add a channel, verify FCM token registers
- [ ] Wait ≤ 5 min for cron to detect a new video, verify push arrives
- [ ] Test tap actions: video tap opens video + marks seen, channel tap opens channel + clears all
- [ ] Test DND: enable DND, verify pushes are suppressed
- [ ] Test nag cycle: ignore a video, verify re-notification on schedule

### Short-term
- [ ] Clean up smoke test device from KV
- [ ] Dead-device cleanup cron (remove `device:*` keys for FCM tokens returning `UNREGISTERED`)
- [ ] Weekly consistency check (reconcile `device:*:channels` ↔ `channel:*:subscribers`)
- [ ] Shorts filtering via YouTube Data API `contentDetails.contentDetails.duration` (Shorts are < 60s vertical)
- [ ] Privacy policy for Play Store submission

### Medium-term
- [ ] Observability: `metrics:{YYYY-MM-DD}` key, daily Telegram summary
- [ ] Cloudflare email alert at 80% of any KV limit
- [ ] WebSub revival: if/when a YouTube-compatible hub reappears, re-enable lease renewal and add a push-handler health check

### Future
- [ ] iOS support (APNs integration)
- [ ] Cross-device sync (optional Google sign-in)
- [ ] Livestream detection via YouTube Data API `liveStreamingDetails`

---

## Cloudflare Free Tier (current observed usage)

| Resource | Limit | Actual |
|----------|-------|--------|
| KV reads | 100,000/day | ~3,000/day |
| KV writes | 1,000/day | ~200/day |
| KV list ops | 1,000/day | **0** (channels:active index) |
| KV storage | 1 GB | < 1 MB |
| Worker requests | 100,000/day | ~500/day |
| Worker CPU time | 10 ms per invocation | < 5 ms |

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
| v3.0.13 | 2026-06-02 | **First fully-shipped v3 release.** APK published on GitHub, FCM key regenerated, all workers repointed to new CF account + KV, build pipeline working end-to-end. |
