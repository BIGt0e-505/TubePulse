# TubePulse — Push Notification Architecture Migration Plan

**Version:** 1.0 (historical)
**Date:** 18 April 2026
**Status:** ✅ **Completed 2026-04-20 → 2026-06-02. v1→v2→v3 migration shipped as v3.0.0 → v3.0.13. The v3.1.x line (2026-06-03 → present) is a feature release on top of v3.0, not a continuation of this migration.**

> This document is kept as a historical record of the v1 (client-polling) → v2 (server-push) migration. For the current state of the project, see [STATUS.md](STATUS.md). For the architecture spec as it exists today, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Why Migrate?

### Current Architecture (Client-Side Polling)
- App registers a background fetch task + foreground service
- Every N minutes, the app wakes up, fetches YouTube RSS feeds for every tracked channel, compares against local state, and fires a local notification if there's new content
- All state (channels, last-seen video IDs, cache) lives in AsyncStorage on the device

### Problems
| Problem | Detail |
|---------|--------|
| **Battery drain** | Foreground service + frequent RSS fetches = persistent background work. Android OEMs also kill background services aggressively, making the app unreliable. |
| **Android 14+ restrictions** | Google is progressively restricting background work. A foreground service for "checking YouTube" risks a red-label warning or outright kill. |
| **Latency** | Poll interval is user-configured (5–120 min) but even at 5 min, there's up to 5 min of delay. Server-side cron at 2 min is feasible. |
| **Reliability** | If the app is killed, force-stopped, or phone reboots, no notifications until the user manually opens the app again. |
| **Scale** | N users × M channels = N×M RSS fetches. Server-side does M fetches total, once, for everyone. |

### Target Architecture (Server-Push via FCM)
- A Cloudflare Worker runs on a cron trigger (every 2–5 min), polls YouTube RSS for all tracked channels across all users, stores state in Workers KV, and pushes FCM notifications to devices
- The app becomes a thin client: register FCM token, receive pushes, display feed, manage settings
- Zero background polling on the device. Zero foreground service.

### Benefits
- ✅ **No battery drain** — app does nothing in the background
- ✅ **No red-label risk** — no foreground service needed
- ✅ **Faster notifications** — server polls more frequently than a phone realistically can
- ✅ **Free tier covers it** — Cloudflare Workers free tier: 100K req/day, 1KV namespace, 10ms CPU. FCM is free. This app won't exceed any limit.
- ✅ **Reliable** — push notifications arrive even if the app is force-stopped

---

## 2. Architecture Overview

```
┌──────────────────┐         ┌─────────────────────────────────┐
│   TubePulse App  │         │      Cloudflare Workers         │
│   (React Native) │         │                                 │
│                  │         │  ┌─────────────────────────┐    │
│  ┌────────────┐  │  FCM    │  │  Cron Worker             │    │
│  │ FCM Token  │◄─┼─────────┼──│  (every 2 min)          │    │
│  │ Handler    │  │  Push   │  │  - Fetch YouTube RSS     │    │
│  └────────────┘  │         │  │  - Compare vs KV state   │    │
│                  │         │  │  - Push FCM if new        │    │
│  ┌────────────┐  │         │  │  - Update KV state       │    │
│  │ REST API   │◄─┼─────────┼──│                           │    │
│  │ (register, │  │  HTTPS  │  └─────────────────────────┘    │
│  │  channels, │  │         │                                 │
│  │  settings)  │  │         │  ┌─────────────────────────┐    │
│  └────────────┘  │         │  │  API Worker              │    │
│                  │         │  │  - Register device token  │    │
│  ┌────────────┐  │         │  │  - Add/remove channels   │    │
│  │ Local UI   │  │         │  │  - Update user settings   │    │
│  │ (feed,     │  │         │  │  - Fetch feed data       │    │
│  │  channels,  │  │         │  │  - Handle-resolver proxy │    │
│  │  settings)  │  │         │  └─────────────────────────┘    │
│  └────────────┘  │         │                                 │
│                  │         │  ┌─────────────────────────┐    │
│                  │         │  │  Workers KV              │    │
│                  │         │  │  - users/{token}         │    │
│                  │         │  │  - channels/{channelId}  │    │
│                  │         │  │  - feed/{channelId}      │    │
│                  │         │  └─────────────────────────┘    │
└──────────────────┘         └─────────────────────────────────┘
         │                               │
         │                               │
         ▼                               ▼
┌──────────────────┐         ┌─────────────────────────────────┐
│  Firebase Cloud   │         │  YouTube RSS                   │
│  Messaging (FCM) │         │  /feeds/videos.xml?channel_id= │
└──────────────────┘         └─────────────────────────────────┘
```

---

## 3. Components to Build

### 3.1 Firebase Project Setup
- Create a Firebase project (`tubepulse` or `tubepulse-app`)
- Enable Cloud Messaging (FCM)
- Generate a private key (service account JSON) for server-side FCM sends — the Worker will use this to authenticate with the FCM HTTP v1 API
- Download `google-services.json` for the Android app
- Note the project number and sender ID for client-side FCM setup

### 3.2 Cloudflare Workers — API Worker (`tubepulse-api`)
This replaces and extends the current `tubepulse-resolver` Worker.

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/register` | Register FCM token + user channels + settings |
| `PUT` | `/channels` | Update tracked channels for a device |
| `PUT` | `/settings` | Update notification settings (mode, DND, per-channel) |
| `POST` | `/seen` | Mark video(s) as seen |
| `GET` | `/feed` | Get current feed data (videos for all tracked channels) |
| `GET` | `/resolve?handle=@x` | Handle→channelId resolution (existing proxy, moved here) |

**Auth:** Simple bearer token — the FCM token itself acts as the device identifier. Each registered token is a "user". No user accounts needed (v1).

**KV Data Model:**

```
Namespace: TUBEPULSE_KV

Keys:
  device:{fcmToken}          → { channels: [...], settings: {...], lastSeen: {...}, registeredAt }
  channel:{channelId}:feed   → { videos: [...], lastFetched, etag }
  channel:{channelId}:meta   → { name, avatar, lastVideoId, lastChecked }
```

### 3.3 Cloudflare Workers — Cron Worker (`tubepulse-cron`)
A separate Worker bound to a Cron Trigger (every 2 minutes).

**Flow:**
1. List all `device:*` keys from KV
2. Collect unique set of channel IDs across all devices
3. For each channel ID, fetch YouTube RSS feed
4. Compare `latestVideoId` against stored `channel:{channelId}:meta.lastVideoId`
5. If new video found:
   - Update `channel:{channelId}:meta` and `channel:{channelId}:feed`
   - For each device tracking this channel:
     - Check if video ID is already in device's `lastSeen`
     - Check notification mode (relentless vs chill) and DND schedule
     - If notification warranted → send FCM push via HTTP v1 API
     - Update device's `lastSeen` for chill mode tracking
6. Done

**FCM Push Payload:**
```json
{
  "message": {
    "token": "<fcm-token>",
    "notification": {
      "title": "<channelName> uploaded",
      "body": "<videoTitle>"
    },
    "data": {
      "videoId": "<id>",
      "channelName": "<name>",
      "handle": "<handle>",
      "videoLink": "<url>",
      "type": "new_video"
    },
    "android": {
      "priority": "high",
      "notification": {
        "channel_id": "new-videos",
        "sound": "default"
      }
    }
  }
}
```

### 3.4 React Native App Changes

**Remove:**
- `src/utils/backgroundTask.js` — entire file (background fetch registration + task definition)
- `src/utils/foregroundService.js` — entire file (foreground service)
- `expo-background-fetch`, `expo-task-manager`, `react-native-background-actions` from package.json
- Background fetch registration from `App.js`
- Foreground service start from `App.js`
- Client-side RSS polling from `HomeScreen.js` (the `checkAllChannels` calls on refresh, auto-fetch, and interval)
- The poll interval setting from `SettingsScreen.js` (server decides poll frequency)

**Add:**
- `src/utils/fcm.js` — FCM token acquisition, push message listeners
- `src/utils/api.js` — REST client for the API Worker (register, update channels, settings, seen, feed)
- `@react-native-firebase/app` + `@react-native-firebase/messaging` to package.json
- Firebase plugin to `app.json` plugins array
- `google-services.json` to `android/app/`

**Modify:**
- `App.js` — Replace background fetch init with FCM setup; handle incoming push messages; on cold start, register token + channels with API Worker
- `HomeScreen.js` — Replace `checkAllChannels` polling with API Worker `/feed` call; pull-to-refresh hits `/feed`; mark-seen hits `/seen`
- `ChannelsScreen.js` — After adding/removing a channel, call API Worker `/channels` to sync
- `SettingsScreen.js` — After changing settings, call API Worker `/settings` to sync; remove poll interval picker
- `src/utils/notifications.js` — Simplify to just handle notification response (tap actions); remove local notification scheduling (FCM handles delivery)
- `src/utils/storage.js` — Keep for local UI state, but "source of truth" for channels/settings moves server-side; cache feed data locally for offline display

### 3.5 Widget
The home screen widget reads from `react-native-android-widget`'s widget store. After migration:
- Widget still works — it reads from local storage which is kept in sync via `/feed` API calls
- On receiving a push, the app updates local cache + requests widget update
- If the app is in background/force-stopped, the push notification itself is visible; widget updates next time the app runs

---

## 4. Migration Phases

### Phase 0: Firebase & Infrastructure Setup
**Goal:** Get the plumbing in place before touching any code.

- [ ] Create Firebase project (`tubepulse-app`) in Firebase Console
- [ ] Enable Cloud Messaging
- [ ] Generate service account key JSON for server-side FCM (store as `FIREBASE_SERVICE_ACCOUNT` Worker secret)
- [ ] Download `google-services.json` → place at `android/app/google-services.json`
- [ ] Create second Worker (`tubepulse-cron`) with Cron Trigger
- [ ] Create KV namespace (`TUBEPULSE_KV`) and bind to both Workers
- [ ] Store `YOUTUBE_API_KEY` and `FIREBASE_SERVICE_ACCOUNT` as Worker secrets

**Verification:** Can manually call FCM API with a test token from the Worker.

### Phase 1: API Worker + Data Model
**Goal:** Build the API Worker that devices register with and query.

- [ ] Create `tubepulse-api` Worker (new, alongside existing resolver)
- [ ] Implement `POST /register` — stores device token + channels + settings in KV
- [ ] Implement `PUT /channels` — updates tracked channels for a token
- [ ] Implement `PUT /settings` — updates notification settings
- [ ] Implement `POST /seen` — marks video IDs as seen for a token
- [ ] Implement `GET /feed` — returns current feed data from KV
- [ ] Implement `GET /resolve?handle=@x` — migrate from existing resolver
- [ ] Deploy API Worker

**Verification:** Can `curl` all endpoints against the deployed Worker.

### Phase 2: Cron Worker + Push Engine
**Goal:** The cron Worker detects new videos and pushes notifications.

- [ ] Create `tubepulse-cron` Worker with `triggers.crons = ["*/2 * * * *"]`
- [ ] Implement: list devices from KV, deduplicate channel IDs
- [ ] Implement: fetch YouTube RSS for each channel, compare against stored state
- [ ] Implement: on new video, iterate devices tracking that channel, check notification rules, send FCM push
- [ ] Implement: chill mode logic (notify once, then 4h reminders)
- [ ] Implement: DND schedule check (respect per-device and per-channel DND settings)
- [ ] Implement: update KV state after each run
- [ ] Deploy Cron Worker

**Verification:** Add a test channel, register a test device, wait for cron to fire, receive push on phone.

### Phase 3: App — Firebase Integration
**Goal:** Wire Firebase into the React Native app.

- [ ] Install `@react-native-firebase/app` and `@react-native-firebase/messaging`
- [ ] Add `google-services.json` to `android/app/`
- [ ] Add Firebase plugin to `app.json`
- [ ] Create `src/utils/fcm.js`:
  - `requestPermission()` — request notification permission
  - `getToken()` — get FCM registration token
  - `onMessage()` — foreground message handler
  - `onBackgroundMessage()` — background/quit message handler
  - `onTokenRefresh()` — handle token rotation, re-register with API
- [ ] Test: app gets FCM token, can receive a test push from Firebase Console

**Verification:** Send test message from Firebase Console → notification arrives on phone.

### Phase 4: App — Remove Client-Side Polling
**Goal:** Gut the old polling, wire up the new API.

- [ ] Remove `src/utils/backgroundTask.js`
- [ ] Remove `src/utils/foregroundService.js`
- [ ] Remove `expo-background-fetch`, `expo-task-manager`, `react-native-background-actions` from `package.json`
- [ ] Create `src/utils/api.js`:
  - `registerDevice(token, channels, settings)` → `POST /register`
  - `updateChannels(token, channels)` → `PUT /channels`
  - `updateSettings(token, settings)` → `PUT /settings`
  - `markSeen(token, handle, videoIds)` → `POST /seen`
  - `fetchFeed(token)` → `GET /feed`
  - `resolveHandle(handle)` → `GET /resolve`
- [ ] Update `App.js`:
  - On mount: get FCM token, call `registerDevice()`
  - On token refresh: re-register
  - Handle push tap (navigate to video/channel)
  - On receiving push in foreground: update local cache, refresh UI
- [ ] Update `HomeScreen.js`:
  - Replace `checkAllChannels()` with `api.fetchFeed()`
  - Pull-to-refresh → `api.fetchFeed()`
  - Mark seen → `api.markSeen()` + local state update
  - Remove interval-based auto-refresh (push handles freshness)
- [ ] Update `ChannelsScreen.js`:
  - On add/remove/reorder → `api.updateChannels()`
- [ ] Update `SettingsScreen.js`:
  - On setting change → `api.updateSettings()`
  - Remove poll interval picker (server controls frequency)
- [ ] Simplify `src/utils/notifications.js`:
  - Remove `sendNewVideoNotification()` (FCM handles delivery)
  - Keep `setupNotificationChannel()` for Android channel config
  - Keep notification response handler logic (moved to App.js FCM handler)
- [ ] Remove `src/utils/rss.js` (no longer used client-side)

**Verification:** App runs, registers with API Worker, receives pushes from Cron Worker, feed displays correctly.

### Phase 5: Polish & Edge Cases
**Goal:** Handle all the details that make it production-ready.

- [ ] **Offline fallback** — If API Worker is unreachable, show cached feed data from last successful fetch
- [ ] **First-launch flow** — New install: get token, register with empty channel list, prompt to add channels
- [ ] **Token rotation** — On FCM token refresh, re-register with API Worker; old token cleaned up
- [ ] **Stale device cleanup** — Cron Worker prunes device tokens that haven't been seen in 30 days
- [ ] **FCM error handling** — If FCM returns `UNREGISTERED` for a token, remove it from KV
- [ ] **Notification channels** — Ensure Android notification channels (sound vs silent) still work with FCM `channel_id` in the push payload
- [ ] **Widget updates** — On push received, update local cache + trigger widget refresh
- [ ] **Rate limiting** — API Worker rate-limits registration/update calls (simple IP or token-based)
- [ ] **Cron Worker observability** — Log channel fetch counts, push counts, errors to Worker tail

**Verification:** Full end-to-end test: add channel → wait ≤2 min → push arrives → tap opens video → mark seen → widget updates.

---

## 5. Data Flow — Post-Migration

### User adds a channel
```
App → POST /register (token + channels including new one)
API Worker → KV: update device:{token}.channels
```

### Cron detects new video
```
Cron Worker → KV: read all device:* keys
Cron Worker → YouTube RSS: fetch feeds for all unique channelIds
Cron Worker → compare latestVideoId vs channel:{channelId}:meta.lastVideoId
Cron Worker → new video found! → for each device tracking this channel:
  → check notification mode + DND
  → FCM HTTP v1: send push to device token
  → KV: update device:{token}.lastSeen (for chill mode)
  → KV: update channel:{channelId}:meta
```

### User opens app / pulls to refresh
```
App → GET /feed (sends FCM token as auth)
API Worker → KV: read feed data for all channels in device:{token}.channels
API Worker → return videos, channel metadata
App → render feed from server data
```

### User marks video as seen
```
App → POST /seen (token + handle + videoIds)
API Worker → KV: update device:{token}.lastSeen
```

### User changes settings
```
App → PUT /settings (token + new settings)
API Worker → KV: update device:{token}.settings
```

---

## 6. KV Data Model — Detailed

### `device:{fcmToken}`
```json
{
  "channels": [
    { "handle": "mkbhd", "channelId": "UCBJycsmduvYEL83R_U4JriQ" }
  ],
  "settings": {
    "notificationMode": "relentless",
    "dndEnabled": false,
    "dndStart": "22:00",
    "dndEnd": "07:00",
    "perChannelNotifications": false,
    "channelNotifSettings": {},
    "tapAction": "video"
  },
  "lastSeen": {
    "mkbhd": { "seenIds": ["abc123", "def456"], "gentleState": null }
  },
  "registeredAt": 1713456789000,
  "lastActiveAt": 1713456789000
}
```

### `channel:{channelId}:meta`
```json
{
  "name": "MKBHD",
  "avatar": "https://yt3.ggpht.com/...",
  "lastVideoId": "abc123",
  "lastVideoTitle": "The New iPhone...",
  "lastVideoPublished": "2026-04-18T15:30:00Z",
  "lastChecked": "2026-04-18T17:08:00Z"
}
```

### `channel:{channelId}:feed`
```json
{
  "videos": [
    {
      "videoId": "abc123",
      "title": "The New iPhone...",
      "published": "2026-04-18T15:30:00Z",
      "thumbnail": "https://i.ytimg.com/...",
      "views": "1500000",
      "link": "https://youtube.com/watch?v=abc123"
    }
  ],
  "lastFetched": "2026-04-18T17:08:00Z"
}
```

---

## 7. Cost Estimate

| Service | Free Tier | Projected Usage | Cost |
|---------|-----------|-----------------|------|
| Cloudflare Workers | 100K req/day | ~720 cron runs/day + ~50 API calls/day | **$0** |
| Cloudflare KV | 100K reads/day, 1K writes/day | ~1K reads/day, ~200 writes/day | **$0** |
| Firebase FCM | Unlimited | ~50 pushes/day | **$0** |
| YouTube RSS | No API key needed | ~300 fetches/day (15 channels × 720 runs / 2-min overlap dedup) | **$0** |
| YouTube Data API | 10K units/day | ~50 handle resolutions/day | **$0** |

**Total: $0/month** for current scale.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **KV read limits** — listing all `device:*` keys on every cron run could hit KV read limits at scale | Use KV `list()` with prefix — efficient. At 1000 devices, that's ~10 list calls per cron run (100 keys/page). Well within free tier. |
| **FCM token rotation** — tokens expire or rotate, pushes silently fail | Handle `UNREGISTERED` errors from FCM API → prune dead tokens from KV. Client re-registers on token refresh. |
| **KV eventual consistency** — writes may not be immediately readable | Acceptable for this use case. A 30-second delay on state updates is fine. Cron runs every 2 min anyway. |
| **Cron Worker 10ms CPU limit** (free tier) | RSS parsing is cheap. 15 channels × XML parse ≈ 2–3ms. If it grows, upgrade to Workers Paid ($5/mo, 50ms CPU). |
| **No user accounts** — if someone reinstalls, they get a new token and lose channel list | Acceptable for v1. Future: add optional Google sign-in for cross-device sync. |
| **Android kills app before FCM handler runs** | FCM high-priority messages wake the app. On Android 14+, FCM is the most reliable delivery mechanism — far more reliable than background fetch. |

---

## 9. What Gets Deleted / Replaced

| File / Package | Action | Replacement |
|----------------|--------|-------------|
| `src/utils/backgroundTask.js` | **Delete** | Cron Worker (server-side) |
| `src/utils/foregroundService.js` | **Delete** | No replacement needed |
| `src/utils/rss.js` | **Delete** | Cron Worker fetches RSS server-side |
| `expo-background-fetch` | **Uninstall** | FCM push |
| `expo-task-manager` | **Uninstall** | FCM push |
| `react-native-background-actions` | **Uninstall** | FCM push |
| `worker/index.js` | **Rewrite** → `tubepulse-api` | API Worker (register, channels, settings, feed, resolve) |
| `worker/wrangler.toml` | **Split** → two Workers | `tubepulse-api/wrangler.toml` + `tubepulse-cron/wrangler.toml` |
| `src/utils/notifications.js` | **Simplify** | Keep channel setup + tap handler; remove `sendNewVideoNotification()` |
| `src/utils/storage.js` | **Simplify** | Local cache only; server is source of truth for channels/settings |
| `src/utils/constants.js` | **Edit** | Remove `BACKGROUND_FETCH_TASK`, `DEFAULT_SETTINGS.pollIntervalMinutes` |

---

## 10. What Stays

| Component | Notes |
|-----------|-------|
| `src/screens/HomeScreen.js` | UI stays the same; data source changes from local RSS → API Worker `/feed` |
| `src/screens/ChannelsScreen.js` | UI stays the same; add/remove channels syncs with API Worker |
| `src/screens/SettingsScreen.js` | UI stays mostly same; remove poll interval picker |
| `src/components/widgetTaskHandler.js` | Widget reads local cache, still works |
| `react-native-android-widget` | Still works |
| `fast-xml-parser` | Move to Cron Worker for RSS parsing |
| App theming, navigation, styling | Unchanged |

---

## 11. Directory Structure — Post-Migration

```
TubePulse/
├── App.js
├── index.js
├── app.json                  # + Firebase plugin
├── package.json              # - background packages, + firebase packages
├── eas.json
├── android/
│   └── app/
│       └── google-services.json   # NEW
├── worker/
│   ├── tubepulse-api/
│   │   ├── index.js          # API Worker (register, channels, settings, feed, resolve)
│   │   └── wrangler.toml
│   └── tubepulse-cron/
│       ├── index.js          # Cron Worker (RSS poll, push engine)
│       └── wrangler.toml     # + cron trigger + KV binding
├── src/
│   ├── screens/
│   │   ├── HomeScreen.js
│   │   ├── ChannelsScreen.js
│   │   └── SettingsScreen.js
│   ├── components/
│   │   └── widgetTaskHandler.js
│   └── utils/
│       ├── api.js            # NEW — REST client for API Worker
│       ├── fcm.js            # NEW — FCM token + message handling
│       ├── storage.js        # Simplified — local cache only
│       ├── notifications.js  # Simplified — tap handler only
│       └── constants.js      # Simplified
└── assets/
```

---

## 12. Testing Strategy

### Phase 0–2 (Infrastructure)
- `curl` tests against API Worker endpoints
- Manual Cron Worker trigger via `wrangler dev --test-scheduled`
- Verify FCM push arrives on test device

### Phase 3–4 (App)
- Install on test device, verify FCM token registration
- Add a channel, verify it appears in KV
- Wait for cron to detect a video (or manually upload to a test channel)
- Verify push arrives, tap opens video
- Verify "mark seen" propagates to server
- Verify pull-to-refresh loads feed from API Worker
- Kill app, force-stop, reboot — verify pushes still arrive (FCM wakes app)

### Phase 5 (Edge Cases)
- Offline mode: airplane mode → re-enable → feed refreshes
- Token rotation: manually delete token → app re-registers
- Stale device: don't open app for 30 days → cron prunes token
- DND: set DND hours → verify no sound during DND, sound outside DND
- Chill mode: verify only one notification per video, then 4h reminders

---

## 13. Rollback Plan

If the push architecture causes issues:
1. The old client-polling code lives in git history — revert to pre-migration commit
2. Both architectures can coexist temporarily: keep client-side polling as fallback during rollout
3. API Worker can return `X-Source: server` header so the app knows data is server-side vs local

---

## 14. Timeline Estimate vs Actual

| Phase | Estimate | Actual | Notes |
|-------|----------|--------|-------|
| Phase 0: Firebase + infra | 1–2 hours | ~2 hours | |
| Phase 1: API Worker | 3–4 hours | ~5 hours | Spread over 2 sessions |
| Phase 2: Cron Worker | 3–4 hours | ~6 hours | Data API poller added post-launch (WebSub hub died) |
| Phase 3: App Firebase | 2–3 hours | ~3 hours | |
| Phase 4: App refactor | 3–4 hours | ~5 hours | More screens affected than anticipated |
| Phase 5: Polish | 2–3 hours | ~6 hours | Fresh-install bootstrap, widget auth, settings field drift |
| Bug-fix patch series (v3.0.1 → v3.0.13) | — | ~8 hours | FCM JWT signing fix was the biggest unblocker |
| **Total** | **14–20 hours** | **~35 hours** | Spanned 2026-04-18 → 2026-06-02 across ~10 sessions |

### Deviations from plan
- **WebSub replaced by YouTube Data API polling** when Google's hub was confirmed shut down. Cron design absorbed the change cleanly.
- **FCM JWT signing was a 2-month silent failure.** The truncated 1216-byte PKCS8 key was the root cause — discovered only when a code path actually exercised `getGoogleAccessToken` end-to-end. Fixed in v3.0.13 by regenerating the key + adding base64 padding + `\n` escape handling in the PEM parser.
- **`v3-restored` branch** — after a botched merge attempt, all v3 work was rebased onto a fresh branch rather than `main`. The release at v3.0.13 lives there.

---

*This plan lives at `/mnt/d/dev/TubePulse/MIGRATION_PLAN.md`. Historical record — superseded by [STATUS.md](STATUS.md) and [ARCHITECTURE.md](ARCHITECTURE.md).*