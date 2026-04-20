# TubePulse v3 Implementation Document

This document describes the complete v3 architecture, the code that implements it, and the exact event sequences that make it work.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Cloudflare Workers](#cloudflare-workers)
3. [KV Schema](#kv-schema)
4. [React Native App](#react-native-app)
5. [Channel Initialization Event Sequence](#channel-initialization-event-sequence)
6. [Notification Event Sequence](#notification-event-sequence)
7. [Bugs Fixed from v1](#bugs-fixed-from-v1)

---

## Architecture Overview

TubePulse v3 is a **channel-first, server-push** architecture. The key change from v1:

- **v1**: App polls YouTube RSS feeds on a timer via a foreground service. O(devices × channels) API calls.
- **v3**: Server subscribes to YouTube channels via WebSub (pubsubhubbub). YouTube pushes new content to the server, which pushes FCM notifications to devices. O(channels with new content) API calls — zero polling.

The system has three components:

1. **tubepulse-api** — Cloudflare Worker handling REST API + WebSub webhook
2. **tubepulse-cron** — Cloudflare Worker handling scheduled tasks (upcoming events, nags, lease renewal)
3. **React Native app** — registers device, subscribes to channels, receives FCM pushes

All state is stored in **Cloudflare KV** using a channel-first key schema. No `KV.list()` calls anywhere.

---

## Cloudflare Workers

### tubepulse-api

**URL**: `https://tubepulse-api.aaronjoakley55.workers.dev`

**wrangler.toml**:
```toml
name = "tubepulse-api"
main = "src/index.js"
compatibility_date = "2024-12-01"
account_id = "93e62acb204fe695139d8441880ed4a3"

[[kv_namespaces]]
binding = "TUBEPULSE_KV"
id = "f2ac3fd3ae9c457287074e7e32c66c64"

[vars]
WEBSUB_HUB = "https://pubsubhubbub.appspot.com/"
WEBSUB_CALLBACK_BASE = "https://tubepulse-api.aaronjoakley55.workers.dev"
MAX_CHANNELS_PER_DEVICE = 100
```

**Secrets** (set via `wrangler secret put`):
- `FIREBASE_SERVICE_ACCOUNT` — Firebase service account JSON
- `YOUTUBE_API_KEY` — YouTube Data API v3 key

**Source files**:
- `src/index.js` — Main router + all 11 endpoint handlers
- `src/kv.js` — KV key schema functions
- `src/crypto.js` — HMAC-SHA1 verification for WebSub
- `src/fcm.js` — Firebase Cloud Messaging via HTTP v1 API with JWT auth
- `src/websub.js` — WebSub subscription management + Atom feed parsing
- `src/youtube.js` — YouTube RSS fetching + Data API handle resolution

#### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/register` | Register device with FCM token |
| POST | `/subscribe-channel` | Subscribe device to a channel (triggers bootstrap) |
| POST | `/unsubscribe` | Unsubscribe device from a channel |
| POST | `/seen` | Mark videos as watched |
| GET | `/feed` | Get all subscribed channels with recent videos |
| GET | `/resolve` | Resolve @handle → channelId + name + avatar |
| POST | `/bootstrap` | Force-fetch channel RSS + metadata |
| POST | `/settings` | Update device notification settings |
| POST | `/channel-override` | Set per-channel notification overrides |
| GET | `/websub` | WebSub verification (hub challenge response) |
| POST | `/websub` | WebSub push (new video notification from YouTube) |

#### Critical Implementation Details

**`/subscribe-channel`** — The most critical endpoint. It does four things atomically:

1. Adds channelId to device's channel list (`device:{id}:channels`)
2. Adds deviceId to channel's subscriber list (`channel:{id}:subscribers`)
3. Bootstraps channel metadata if first-ever subscriber (RSS fetch + Data API for avatar)
4. Initiates WebSub subscription if first subscriber for this channel

**Important**: The response includes `{ channel: { name, avatarUrl, recentVideos: [...] } }` so the app can immediately display content without a second API call. The `recentVideos` array is read from the RSS fetch result and re-attached to the response after being stored separately in KV.

**`/resolve`** — Returns `{ channelId, name, avatarUrl }` from the YouTube Data API. Results are cached in KV for 7 days under `handle:{handle}`. The name and avatar are included so the app can display them even if the subsequent `/subscribe-channel` bootstrap fails.

**`/feed`** — Reads `device:{id}:channels` to get the list, then fetches `channel:{id}:meta`, `channel:{id}:recent`, and `device:{id}:state:{channelId}` for each. Includes an auto-enrichment step: if `meta.name === channelId` (raw ID), calls the Data API to fetch the real name/avatar and saves it back.

**`/websub` POST** — Verifies HMAC-SHA1 signature (NOT SHA-256 — this was a v1 bug), parses Atom feed, deduplicates against `channel:{id}:recent`, schedules upcoming events for livestreams, and notifies all subscribers via FCM.

**`/bootstrap`** — Supports `force: true` to re-fetch even if channel exists. Auto-enriches channel names that are still raw channelIds by calling the Data API.

### tubepulse-cron

**URL**: `https://tubepulse-cron.aaronjoakley55.workers.dev`

**wrangler.toml**:
```toml
name = "tubepulse-cron"
main = "src/index.js"
compatibility_date = "2024-12-01"
account_id = "93e62acb204fe695139d8441880ed4a3"

[[kv_namespaces]]
binding = "TUBEPULSE_KV"
id = "f2ac3fd3ae9c457287074e7e32c66c64"

[triggers]
crons = ["*/5 * * * *", "*/15 * * * *", "0 */6 * * *"]
```

**Secret**: `FIREBASE_SERVICE_ACCOUNT`

#### Cron Jobs

| Schedule | Job | What it does |
|----------|-----|-------------|
| */5 | Upcoming | Reads `upcoming:{bucket}` for current 5-min window, sends FCM for live_soon/live_now events |
| */15 | Nag | Reads `nag:{bucket}` for current 15-min window, checks DND, sends nag reminders |
| 0 */6 | Lease renewal | Reads `channels:active`, renews WebSub subscriptions expiring within 24h |

---

## KV Schema

All keys use `:` as separator. No `KV.list()` calls — every read targets a specific key.

### Channel keys
```
channel:{channelId}:meta          → { name, avatarUrl, channelId, addedAt }
channel:{channelId}:subscribers   → [deviceId, deviceId, ...]
channel:{channelId}:websub        → { leaseExpiresAt, hmacSecret, lastVerified }
channel:{channelId}:recent        → [{ videoId, title, publishedAt, thumbnail }, ...]
```

### Device keys
```
device:{deviceId}:profile         → { fcmToken, platform, appVersion, createdAt, lastSeenAt }
device:{deviceId}:channels        → [channelId, channelId, ...]
device:{deviceId}:settings        → { mode, nagInterval, dndEnabled, dndStart, dndEnd, tapAction }
device:{deviceId}:override:{chId} → { mode?, nagInterval?, dndBypass?, muted? }
device:{deviceId}:state:{chId}    → { unwatched: [videoId, ...], lastNagAt, nagCount }
```

### Index key
```
channels:active                   → [channelId, channelId, ...]
```

### Cache keys
```
handle:{handle}                   → { channelId, name, avatarUrl, cachedAt }
upcoming:{bucket}                 → [{ channelId, videoId, type, scheduledFor }, ...]
nag:{bucket}                      → [{ deviceId, channelId, videoIds }, ...]
```

Time buckets are aligned to wall-clock minutes:
- Upcoming: `upcoming:2026-04-20T14:05` (5-min aligned)
- Nag: `nag:2026-04-20T14:15` (15-min aligned)

### kv.js
```javascript
export const KV = {
  channelMeta: (channelId) => `channel:${channelId}:meta`,
  subscribers: (channelId) => `channel:${channelId}:subscribers`,
  websub: (channelId) => `channel:${channelId}:websub`,
  recent: (channelId) => `channel:${channelId}:recent`,
  deviceProfile: (deviceId) => `device:${deviceId}:profile`,
  deviceSettings: (deviceId) => `device:${deviceId}:settings`,
  deviceChannels: (deviceId) => `device:${deviceId}:channels`,
  deviceOverride: (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState: (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  channelsActive: () => 'channels:active',
};
```

---

## React Native App

### Key files changed from v1

| File | Change |
|------|--------|
| `App.js` | Replaced foreground service + background fetch with FCM registration + v3 init |
| `src/utils/api.js` | **NEW** — v3 API client for all endpoints |
| `src/utils/constants.js` | `mode` (not `notificationMode`), removed `pollIntervalMinutes`, added `DEFAULT_CHANNELS` |
| `src/utils/storage.js` | channelId-based cache, `isV3Initialized()`, `migrateFromV1()` |
| `src/utils/notifications.js` | Simplified — just permission request + Android notification channels |
| `src/screens/HomeScreen.js` | Uses `/feed` endpoint, thumbnails on video rows |
| `src/screens/ChannelsScreen.js` | Uses `/resolve` + `/subscribe-channel`, per-channel overrides |
| `src/screens/SettingsScreen.js` | Pushes settings to server, removed poll interval |
| `src/components/widgetTaskHandler.js` | channelId-based cache |

### Files removed
- `src/utils/rss.js` — No more client-side RSS fetching
- `src/utils/backgroundTask.js` — No more background fetch tasks
- `src/utils/foregroundService.js` — No more foreground service

### App.js — initV3()

This is the critical initialization sequence. It runs once on first v3 launch:

```javascript
async function initV3() {
  // 1. Request notification permissions
  await requestPermissions();
  await setupNotificationChannel();

  // 2. Get FCM token from Expo
  const fcmToken = await getFCMToken();

  // 3. Register device with server
  await registerDevice(fcmToken, Platform.OS, '3.0.0');

  // 4. Check if already initialized
  const initialized = await isV3Initialized();
  if (!initialized) {
    const cache = {};
    const lastSeen = {};
    const channelList = [];

    // 5. Subscribe pre-seeded channels — capture response data for immediate display
    for (const ch of DEFAULT_CHANNELS) {
      const result = await subscribeChannel(ch.channelId);
      channelList.push({
        channelId: ch.channelId,
        handle: ch.handle,
        name: result?.channel?.name || ch.name,
      });

      if (result?.channel) {
        cache[ch.channelId] = {
          name: result.channel.name || ch.name,
          avatar: result.channel.avatarUrl || null,
          recent: result.channel.recentVideos || [],
          lastFetched: new Date().toISOString(),
        };
        // Mark all existing videos as seen (fresh install = clean slate)
        lastSeen[ch.channelId] = {
          seenIds: (result.channel.recentVideos || []).map(v => v.videoId),
        };
      }
    }

    // 6. Save everything locally
    await saveChannels(channelList);
    await saveChannelCache(cache);
    await saveLastSeen(lastSeen);

    // 7. Push settings to server
    const settings = await getSettings();
    await updateSettings({
      mode: settings.mode || 'chill',
      nagInterval: settings.nagInterval || 30,
      dndEnabled: settings.dndEnabled || false,
      dndStart: settings.dndStart || '22:00',
      dndEnd: settings.dndEnd || '07:00',
      tapAction: settings.tapAction || 'video',
    });

    // 8. Set initialized flag — never runs again
    await setV3Initialized();
  }
}
```

### Adding a channel (ChannelsScreen.js)

When the user types `@handle` and taps Add:

```javascript
const addChannel = async () => {
  const handle = newHandle.trim().replace(/^@/, '');

  // Step 1: Resolve handle to channelId + name + avatar
  const resolveResult = await resolveHandle(handle);
  // Returns: { channelId, name, avatarUrl }

  // Step 2: Subscribe via server (triggers bootstrap + WebSub)
  const subResult = await subscribeChannel(resolveResult.channelId);
  // Returns: { channel: { name, avatarUrl, recentVideos: [...] } }

  // Step 3: Update local state with server response data
  const channelName = subResult.channel?.name || resolveResult.name || handle;
  const updated = [...channels, { channelId, handle, name: channelName }];
  await saveChannels(updated);

  // Step 4: Save to cache (uses subscribe response, not a second API call)
  const existingCache = await getChannelCache();
  existingCache[channelId] = {
    name: channelName,
    avatar: subResult.channel?.avatarUrl || resolveResult.avatarUrl || null,
    recent: subResult.channel?.recentVideos || [],
  };
  await saveChannelCache(existingCache);

  // Step 5: Mark all existing videos as seen (clean slate)
  const lastSeen = await getLastSeen();
  lastSeen[channelId] = { seenIds: (subResult.channel?.recentVideos || []).map(v => v.videoId) };
  await saveLastSeen(lastSeen);
};
```

---

## Channel Initialization Event Sequence

### Pre-seeded channels (first app launch)

```
App launches
  │
  ├─ 1. App: requestPermissions() → user grants notification permission
  ├─ 2. App: getFCMToken() → Expo returns FCM registration token
  ├─ 3. App: POST /register { fcmToken, platform: "android", appVersion: "3.0.0" }
  │     Server: stores device:{uuid}:profile
  │     Server: returns { ok: true }
  │
  ├─ 4. App: isV3Initialized() → false (first launch)
  │
  ├─ 5. App: POST /subscribe-channel { channelId: "UCDZThIzxlU2VzqO4ChHz_xg" }
  │     Server: reads device:{uuid}:channels → [] (empty)
  │     Server: pushes "UCDZ..." to device:{uuid}:channels
  │     Server: reads channel:UCDZ...:subscribers → null (first time)
  │     Server: creates channel:UCDZ...:subscribers = [deviceId]
  │     Server: reads channel:UCDZ...:meta → null (not bootstrapped)
  │     │
  │     Server: YouTube.fetchChannelRSS("UCDZ...")
  │     │   ├─ GET https://www.youtube.com/feeds/videos.xml?channel_id=UCDZ...
  │     │   ├─ Parses <name>MattO</name> from Atom <author>
  │     │   ├─ Parses <media:thumbnail url="..."> from each <entry> for video thumbs
  │     │   ├─ No channel avatar in RSS → calls Data API:
  │     │   │   GET .../youtube/v3/channels?part=snippet&id=UCDZ...&key=...
  │     │   │   Returns: snippet.title="MattO", snippet.thumbnails.default.url="https://yt3..."
  │     │   └─ Returns { name: "MattO", avatarUrl: "https://yt3...", recentVideos: [{ videoId, title, thumbnail }, ...] }
  │     │
  │     Server: saves channel:UCDZ...:meta = { name: "MattO", avatarUrl: "...", channelId, addedAt }
  │     Server: saves channel:UCDZ...:recent = [{ videoId, title, publishedAt, thumbnail }, ...]
  │     │
  │     Server: subscribers.length === 1 → FIRST SUBSCRIBER
  │     Server: generates HMAC secret (32 random bytes → hex)
  │     Server: saves channel:UCDZ...:websub = { leaseExpiresAt, hmacSecret, lastVerified }
  │     Server: ctx.waitUntil → POST https://pubsubhubbub.appspot.com/
  │     │   hub.callback=https://tubepulse-api.../websub
  │     │   hub.mode=subscribe
  │     │   hub.topic=https://www.youtube.com/feeds/videos.xml?channel_id=UCDZ...
  │     │   hub.secret=hmacSecret
  │     Server: adds "UCDZ..." to channels:active
  │     │
  │     Server: returns { ok: true, channel: { name: "MattO", avatarUrl: "...", recentVideos: [...] }, wasFirstSubscriber: true }
  │
  ├─ 6. App: captures subscribe response data
  │     App: channelList.push({ channelId: "UCDZ...", handle: "mattdoesartandstuff", name: "MattO" })
  │     App: cache["UCDZ..."] = { name: "MattO", avatar: "https://yt3...", recent: [...15 videos...] }
  │     App: lastSeen["UCDZ..."] = { seenIds: ["2Q40gbAHCAg", "FC9g1K-GfAE", ...] } ← ALL marked as seen
  │
  ├─ 7. App: POST /subscribe-channel { channelId: "UCZzoiefHjq3WTDorjSUqLfg" }
  │     ... identical flow for DND Rebecca AFTG ...
  │
  ├─ 8. App: saveChannels(channelList) → AsyncStorage
  │     App: saveChannelCache(cache) → AsyncStorage
  │     App: saveLastSeen(lastSeen) → AsyncStorage
  │
  ├─ 9. App: POST /settings { mode: "chill", nagInterval: 30, dndEnabled: false, ... }
  │     Server: saves device:{uuid}:settings
  │
  ├─ 10. App: setV3Initialized() → AsyncStorage "tubepulse_v3_initialized" = "true"
  │
  └─ 11. HomeScreen renders — channels, avatars, video thumbnails all visible immediately
         (No second API call needed — data came from subscribe response)
```

### Adding a channel by handle

```
User types "@DamienKorgorovitick" and taps Add
  │
  ├─ 1. App: GET /resolve?handle=DamienKorgorovitick
  │     Server: checks KV handle:damienkorgorovitick → miss
  │     Server: YouTube.resolveHandle("DamienKorgorovitick")
  │     │   GET .../youtube/v3/channels?part=id,snippet&forHandle=DamienKorgorovitick&key=...
  │     │   Returns: { id: "UC0ngky2COKu2R-YZftXP7CQ", snippet: { title: "Damien Korgorovitick", thumbnails: {...} } }
  │     Server: saves handle:damienkorgorovitick = { channelId, name, avatarUrl, cachedAt }
  │     Server: returns { channelId: "UC0ngky2COKu2R-YZftXP7CQ", name: "Damien Korgorovitick", avatarUrl: "https://yt3..." }
  │
  ├─ 2. App: checks duplicate → not already in list
  │
  ├─ 3. App: POST /subscribe-channel { channelId: "UC0ngky2COKu2R-YZftXP7CQ" }
  │     Server: bootstraps channel (RSS + Data API for avatar)
  │     Server: initiates WebSub subscription
  │     Server: returns { channel: { name: "Damien Korgorovitick", avatarUrl: "...", recentVideos: [{ videoId: "PMyUM33z7tk", title: "also whose sock is that ?", thumbnail: "https://i1.ytimg.com/...", ... }] } }
  │
  ├─ 4. App: saves channel to local list + cache
  │     App: marks all existing videos as seen: lastSeen["UC0ng..."] = { seenIds: ["PMyUM33z7tk", "eor-Jmf1ZSg"] }
  │
  └─ 5. UI updates immediately — channel appears with avatar, name, and video thumbnails
```

---

## Notification Event Sequence

When a YouTuber uploads a new video:

```
YouTube pushes to WebSub hub
  │
  ├─ 1. Hub: POST https://tubepulse-api.../websub?hub.topic=https://...channel_id=UCDZ...
  │     Body: Atom XML with new <entry>
  │     Header: X-Hub-Signature: sha1=<hex>
  │
  ├─ 2. Server: reads channel:UCDZ...:websub → { hmacSecret }
  │     Server: CryptoAPI.verifyHMACAsync(body, signature, hmacSecret)
  │     │   Uses Web Crypto API with HMAC-SHA-1 (NOT SHA-256)
  │     │   Constant-time hex comparison
  │     Server: signature valid → continue
  │
  ├─ 3. Server: WebSub.parseAtomFeed(body) → [{ videoId, title, publishedAt, channelName }]
  │     Server: reads channel:UCDZ...:recent → deduplicate
  │     Server: prepends new videos to recent (max 15)
  │
  ├─ 4. Server: reads channel:UCDZ...:subscribers → [deviceId1, deviceId2]
  │
  ├─ 5. For each subscriber:
  │     Server: reads device:{id}:profile → { fcmToken }
  │     Server: reads device:{id}:settings → { mode, dndEnabled, ... }
  │     Server: reads device:{id}:override:{channelId} → { muted?, dndBypass?, ... }
  │     Server: resolves effective settings (override wins over global)
  │     │
  │     If muted → skip
  │     If DND active and !dndBypass → schedule nag for DND end instead
  │     Otherwise:
  │     │
  │     ├─ 6. Server: FCM.send(fcmToken, { type, channelId, videoId, title, channelName })
  │     │     Builds JWT from Firebase service account private key
  │     │     Exchanges JWT for Google OAuth2 access token
  │     │     POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
  │     │     Android notification channel: "tubepulse_live" for livestreams, "tubepulse_default" for videos
  │     │
  │     ├─ 7. Server: updates device:{id}:state:{channelId}.unwatched += [videoId]
  │     │
  │     └─ 8. Server: schedules nag
  │           Chill mode: nag in 4 hours
  │           Relentless mode: nag in nagInterval minutes (default 30)
  │           Writes to nag:{bucket} key
  │
  └─ 9. Device receives FCM push
        App: displays notification (Expo Notifications handler)
        App: notification tap → marks seen locally + calls POST /seen
        App: opens YouTube video or channel page based on tapAction setting
```

### Livestream upcoming events

For scheduled livestreams (video publishedAt is in the future):

```
WebSub push arrives with scheduled livestream
  │
  ├─ Server: classifies video type as "live_scheduled"
  │
  ├─ Server: schedules two upcoming events:
  │     1. "live_soon" — 30 minutes before scheduled time
  │     2. "live_now" — at scheduled time
  │     Written to upcoming:{bucket} keys
  │
  ├─ Cron fires (every 5 minutes)
  │     Reads upcoming:{current_bucket}
  │     For each entry:
  │       Reads channel subscribers
  │       Sends FCM with type "live_soon" or "live_now"
  │       Livestream notifications bypass DND
  │     Deletes the bucket
  │
  └─ Cron: 0 */6 * * * — Lease renewal
        Reads channels:active
        For each channel, checks channel:{id}:websub.leaseExpiresAt
        If expiring within 24h, re-subscribes via WebSub hub
```

---

## Bugs Fixed from v1

| Bug | v1 Behavior | v3 Fix |
|-----|-------------|--------|
| HMAC algorithm | Used SHA-256 for WebSub verification | Uses SHA-1 (YouTube hub sends SHA-1 signatures) |
| DND timezone | Used UTC for DND checks | Uses device local time (HH:MM comparison) |
| Settings field name | `notificationMode` | `mode` (matches server schema) |
| Poll interval | Client-side `pollIntervalMinutes` | Removed — server handles all timing |
| KV.list() | Used list() to enumerate keys | Never — uses `channels:active` index and direct key reads |
| Channel avatar | Tried `<uri>` from RSS (which is the channel URL) | Fetches from YouTube Data API `snippet.thumbnails` |
| Video thumbnails | Not extracted from RSS | Parses `<media:thumbnail url="...">` from each `<entry>` |
| subscribe-channel response | Returned `channel` without `recentVideos` (deleted from object before response) | Stores `recentVideos` separately, re-attaches to response |
| Fresh install | Required app restart to see pre-seeded channel content | `initV3()` uses subscribe response data directly — no second API call |
| Adding channels | Existing videos shown as unwatched | All existing videos marked as seen on fresh subscription |