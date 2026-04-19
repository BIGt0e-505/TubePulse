# TubePulse — Project Status

**Last updated:** 2026-04-19  
**Current version:** 2.4.3 (APK built, not yet tested)  
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)  
**Platform:** Android only (React Native + Expo)

---

## Current State

### Workers: OFFLINE
Both Cloudflare Workers have been **deleted** to stay under KV free tier limits.

- `tubepulse-api` — REST API + WebSub callback (deleted)
- `tubepulse-cron` — Nag cycle + subscription renewal (deleted)

**KV namespace** (`f2ac3fd3ae9c457287074e7e32c66c64`) still exists with data intact. Workers can be redeployed when ready.

**Reason:** Cloudflare free tier limits were being hit — particularly **list operations** (508 of 1,000/day at 50% warning). The cron was running every 5 minutes, each run doing 2+ `list()` calls (devices + subscriptions), which alone consumed ~576 list ops/day.

### App: v2.4.3 built, pending testing
- [GitHub Release](https://github.com/Undert0e-505/TubePulse/releases/tag/v2.4.3)
- Includes all fixes through today's session

---

## Architecture Overview

```
┌─────────────┐     WebSub Push      ┌──────────────────┐
│  YouTube RSS │ ──────────────────→  │  tubepulse-api   │
│  Feed Hub    │                      │  (Cloudflare)    │
└─────────────┘                      │                  │
                                      │  /websub  ← push│
                                      │  /register      │
┌─────────────┐   REST + FCM push    │  /resolve       │
│  Android App │ ←─────────────────  │  /bootstrap     │
│  (React Nav) │                      │  /feed          │
└─────────────┘                      │  /seen          │
                                      │  /channels       │
┌─────────────┐   every 15min        │  /settings       │
│tubepulse-cron│ ──────────────────→ └──────┬───────────┘
│ (Cloudflare) │  reads KV, sends           │
│              │  FCM nags                  │
└─────────────┘                  ┌─────────▼─────────┐
                                 │  Cloudflare KV     │
                                 │  (shared namespace)│
                                 └────────────────────┘
```

### Key Design Decisions
- **WebSub over RSS polling** — instant push, zero battery drain, infinite scalability
- **UUID as device identity** — FCM tokens rotate; UUID is stable across token refresh
- **YouTube Data API only for channel PFPs** — at add time (1 quota unit per resolve). No API calls in cron/workers.
- **RSS/WebSub for all video detection** — doesn't scale to use YouTube API for polling
- **channelId over handle** — handles can change; channelId is stable primary key
- **Chill mode default** — notify once, gentle nudge every 4h. Relentless: re-nag every nagInterval.
- **15min hardcoded upcoming lead** — decoupled from nagInterval (5min nag shouldn't mean 5min livestream warning)

---

## Bugs Fixed (Today's Session)

### 1. Notification spam — batch repeating every 5 minutes
**Root cause:** Cron sent batch notifications but didn't update nag/gentle state for included videos. Next cycle saw same unwatched videos, sent another batch.  
**Fix:** Moved state updates to after successful send. Batch notifications now update `nagState`/`gentleState` for all included videos.  
**Commit:** `4b033ed`

### 2. Channel tap not clearing unread videos
**Root cause:** `/seen` with `clearAll:true` only deleted `gentleState`, not `nagState` or `scheduledState`. Cron kept re-nagging.  
**Fix:** `/seen` now clears `gentleState`, `nagState`, and `scheduledState` on clearAll. Individual video seen deletes that videoId from nagState.  
**Commit:** `c807b7b`

### 3. New channels show no videos after bootstrap
**Root cause (a):** HomeScreen `refresh()` built `newCache` only from `/feed` server response. Channels not yet cached by server (no WebSub push) were dropped entirely, wiping bootstrapped data.  
**Root cause (b):** `refresh()` read from React component state (`cache`) which could be stale if bootstrap hadn't finished writing to AsyncStorage yet.  
**Fix:** Refresh now reads from AsyncStorage (not stale state). Channels in server response use max(server, local) video count. Channels NOT in server response are preserved from local cache.  
**Commits:** `83b1bd2`, `1b5cafc`

### 4. Bootstrap running on every app launch
**Root cause:** No check for existing cached videos — re-fetched RSS for all channels every launch.  
**Fix:** Skip channels that already have cached videos.  
**Commit:** `83b1bd2`

### 5. Channel resolve fails on fresh install
**Root cause:** `/resolve` requires a registered device. If registration hasn't completed before user adds a channel, returns "Device not registered" (shown as generic "Couldn't find" error).  
**Fix:** Re-register device before calling `/resolve`. Added `forUsername` fallback for legacy channels without `@` handles. Better error messages.  
**Commit:** `b0266b4`

### 6. KV usage hitting free tier limits
**Root cause:** Cron every 5min (288 runs/day) × list operations (2+ per run) = 576+ list ops/day, exceeding 1,000/day free tier.  
**Fix:** Cron interval 5→15min (96 runs/day). Feed caching across devices (read each channel feed once, not per-device).  
**Commits:** `3cec5c2`  
**Current status:** Workers deleted until ready to redeploy.

---

## Notification System

### Modes
| Mode | Behavior |
|------|----------|
| **Chill** (default) | Notify once, gentle nudge every 4h |
| **Relentless** | Re-nag every `nagInterval` (5m/15m/30m/1h/2h) |

### DND
- Blocks all pushes including livestreams
- Per-channel can override
- When DND ends: multiple pending videos → single batch summary notification

### Notification tap
| Setting | Behavior |
|---------|----------|
| **Video** (default) | Marks single video seen, opens video link |
| **Channel** | Marks ALL unwatched videos for that channel as seen, opens channel page |

### FCM notification tags
- `tubepulse-batch` — batch summaries replace previous (dedup)
- `video-{videoId}` — individual video notifications (one per video)

---

## Known Limitations

| Limitation | Reason | Possible Fix |
|-------------|--------|---------------|
| Can't distinguish Shorts vs regular uploads | YouTube RSS doesn't differentiate | YouTube Data API `contentDetails` (1 quota unit, batch 50 IDs) |
| Can't detect community posts | Not in RSS feed | Would need YouTube Data API polling (doesn't scale) |
| Can't separately detect livestreams | RSS doesn't distinguish types | YouTube Data API `liveStreamingDetails` |
| Scheduled events use `<published>` timestamp | RSS only provides publish time | Works for premieres/livestreams with future dates |
| Handle changes break tracking | Handles are mutable | Always use `channelId` as primary key |

---

## Cloudflare Workers

### tubepulse-api
**Purpose:** REST API for app + WebSub callback endpoint  
**URL:** `https://tubepulse-api.aaronjoakley55.workers.dev` (currently deleted)  
**Endpoints:**
- `POST /register` — Register/update device (FCM token + channels + settings)
- `PUT /channels` — Update tracked channels
- `PUT /settings` — Update notification settings
- `POST /seen` — Mark videos as seen (video tap or channel clear)
- `GET /feed` — Get current feed data for all tracked channels
- `GET /resolve` — Handle → channelId resolution (forHandle + forUsername fallback)
- `GET /bootstrap` — Fetch RSS + avatar for newly added channel (sync)
- `GET /websub` — WebSub verification handshake
- `POST /websub` — WebSub push callback (new video detected)

**Secrets:** `FIREBASE_SERVICE_ACCOUNT`, `YOUTUBE_API_KEY`

### tubepulse-cron
**Purpose:** Nag cycle + WebSub lease renewal  
**Schedule:** `*/15 * * * *` (every 15 min, currently disabled)  
**Jobs:**
1. Renew WebSub subscriptions expiring within 24h
2. Nag cycle — check unwatched videos per device, send FCM pushes

**Secrets:** `FIREBASE_SERVICE_ACCOUNT`

### Shared KV Namespace
- **ID:** `f2ac3fd3ae9c457287074e7e32c66c64`
- **Prefixes:**
  - `device:` — Device data (FCM token, channels, settings, lastSeen state)
  - `channel:` — Channel metadata (name, avatar, lastVideo)
  - `feed:` — Channel feed data (cached video lists)
  - `sub:` — WebSub subscription state + HMAC secret

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v2.1.0 | 2026-04-18 | WebSub push architecture, UUID auth, HMAC verification |
| v2.1.1 | 2026-04-18 | Bug fixes |
| v2.2.0 | 2026-04-18 | DND batching, per-channel notification overrides |
| v2.2.1 | 2026-04-18 | Bug fixes |
| v2.3.0 | 2026-04-19 | Default notification mode → chill, comprehensive README |
| v2.3.1 | 2026-04-19 | Bootstrap ordering fix (sync channels before /bootstrap) |
| v2.3.2 | 2026-04-19 | Bootstrap only for empty channels, HomeScreen cache merge |
| v2.4.0 | 2026-04-19 | Batch nag state fix, notification dedup (tags), /seen state clearing |
| v2.4.1 | 2026-04-19 | HomeScreen refresh preserves local-only channels |
| v2.4.2 | 2026-04-19 | Refresh reads AsyncStorage (not stale state), forUsername fallback |
| v2.4.3 | 2026-04-19 | Re-register device before resolve, better error messages |

---

## Key Files

### App
| File | Purpose |
|------|---------|
| `App.js` | Main entry, FCM setup, device registration, bootstrap, notification tap handling |
| `src/screens/HomeScreen.js` | Main UI, channel list, video list, refresh/fetch logic |
| `src/screens/ChannelsScreen.js` | Add/remove channels, drag-to-reorder, per-channel settings |
| `src/screens/SettingsScreen.js` | Notification mode, nag interval, DND, tap action |
| `src/utils/api.js` | REST client for API worker (deviceId auth) |
| `src/utils/fcm.js` | FCM token management, message handlers |
| `src/utils/storage.js` | AsyncStorage wrapper (channels, cache, lastSeen, settings) |
| `src/utils/constants.js` | Default channels, settings, colors |
| `src/utils/notifications.js` | Android notification channel setup |
| `src/components/TubePulseWidget.js` | Home screen widget |

### Workers
| File | Purpose |
|------|---------|
| `worker/tubepulse-api/index.js` | REST API + WebSub callback |
| `worker/tubepulse-api/wrangler.toml` | API worker config |
| `worker/tubepulse-cron/index.js` | Nag cycle + subscription renewal |
| `worker/tubepulse-cron/wrangler.toml` | Cron worker config |

### Build
| File | Purpose |
|------|---------|
| `build-and-release.sh` | Build APK via EAS, create GitHub release |
| `app.json` | Expo config (version, Android package) |

---

## Next Steps

### Immediate (when ready to re-enable)
1. [ ] Redeploy both workers to Cloudflare
2. [ ] Set cron to 15min interval (`*/15 * * * *`)
3. [ ] Test v2.4.3 APK — verify channel add works and preinstalled channels populate
4. [ ] Monitor KV usage for 24h to confirm under limits

### Short-term improvements
- [ ] Shorts filtering via YouTube Data API `contentDetails` (1 quota unit, batch 50 IDs)
- [ ] Privacy policy for Play Store submission
- [ ] Consider upgrading to Cloudflare Paid plan ($5/month) if usage grows

### Future considerations
- [ ] Nag cycle scaling refactor (channel-first inversion) if user base grows
- [ ] Livestream detection via YouTube Data API `liveStreamingDetails`
- [ ] iOS support (would need APNs integration alongside FCM)

---

## Cloudflare Free Tier Limits

| Resource | Limit | Current Usage (with 15min cron) |
|----------|-------|--------------------------------|
| KV reads | 100,000/day | ~3,000/day |
| KV writes | 1,000/day | ~100/day |
| KV list ops | 1,000/day | ~200/day |
| KV storage | 1 GB | < 1 MB |
| Worker requests | 100,000/day | ~500/day |
| Worker CPU time | 10 ms per invocation | < 5 ms |

**Paid plan ($5/month):** 10M reads, 1M writes, 10M requests/day — eliminates all concerns.