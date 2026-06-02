# TubePulse

Never miss a video from the creators you actually care about. **Android only.**

TubePulse is a lightweight YouTube tracker for Android that monitors your favourite channels and notifies you the moment they upload. No algorithm, no recommendations, no rabbit holes — just a clean list of who's posted what, in the order they posted it.

## Features

### 📺 Channel Tracking
- Add channels by handle (`@handle`) — no URLs, no pasting video links
- Resolves handles to channel IDs via YouTube Data API v3 (proxied through Cloudflare Worker)
- **Channel ID is the primary key** — handles can change, but channel IDs don't. Once resolved at add-time, the channel is tracked by ID even if the creator rebrands.
- Draggable channel list — reorder by priority
- Per-channel avatars cached locally
- Comes with two default channels to get you started — remove or add your own

> **Note:** Each device registers independently. There's no cross-device sync — if you install TubePulse on two phones, each manages its own channel list and settings.

### ⚡ New-Video Detection
TubePulse detects new uploads via a **YouTube RSS feed poller** running on a Cloudflare Worker cron (every 5 min). Originally it used **WebSub** (PubSubHubbub) for push-style detection, but Google's `pubsubhubbub.appspot.com` hub was shut down in 2024, and the v3.0.18 build abandoned the YouTube Data API poller because RSS provides the same data at zero quota cost.

**Active path (since v3.0.18):**
- **RSS-based polling** — cron hits `https://www.youtube.com/feeds/videos.xml?channel_id=...` every 5 min for every channel with at least one subscriber
- **Zero YouTube Data API quota cost** — RSS is a free public feed
- **Latency** — up to 5 min between upload and detection
- **Includes view counts** — RSS carries `media:community/media:statistics/@_views` so we don't need a separate API call
- **The YouTube Data API is reserved for subscribe-time only** — handle→channelId resolve (1 unit, cached 7 days) and avatar fetch (1 unit per new channel, cached forever)

**WebSub (dormant):** the `/websub` endpoints and handler code remain in the workers for:
- Manual testing
- Future YouTube-compatible hub revival
- Self-hosted hub integration

When a new video is detected, the worker pushes it to all eligible devices via FCM. New videos appear within 5 minutes of upload. WebSub leases would expire (typically 5 days), so a cron job would renew subscriptions 24 hours before expiry if the hub were active. The last device to remove a channel would trigger an unsubscribe.

**Scheduled event detection:** RSS entries with a future `publishedAt` are treated as scheduled livestreams/premieres:
- Stored silently when detected — no immediate notification
- **"Going live soon"** notification sent **30 minutes** before the scheduled start (hard-coded, not nag-interval based)
- **"Is live"** notification sent when the scheduled time passes
- Then nagged like any other unwatched video until you watch it

Shorts are currently not filtered — they're treated as regular uploads.

### 🔔 Smart Notifications

TubePulse's notification system is built around **nagging**, not polling. You control how often you're allowed to be nagged about an unwatched video:

- **Nag interval** — 5m / 15m / 30m / 1h / 2h (default 15m)
- **Chill mode** (default) — notify once, then nudge every 4 hours until you watch it
- **Relentless mode** — re-nag every nag interval until you watch the video
- **Per-channel overrides** — set different notification modes and DND per creator
- **DND scheduling** — blocks all pushes during custom silent hours (default 22:00–07:00). Videos that arrive during DND are held and delivered when DND ends by the nag cycle.
- **DND batching** — when DND ends and multiple unwatched videos are pending for the same channel, TubePulse sends a single per-channel summary (e.g. `ChannelName - 3 unwatched`) instead of flooding you with individual notifications. The batch groups by channel — you'll get one notification per channel with its unwatched count, not one per video.

When the RSS poller detects a new video (every 5 min), TubePulse immediately notifies all eligible devices (unless DND is active). The nag cycle then handles re-notifications on the user's chosen schedule.

### 👆 Tap Actions — Video vs Channel

When you tap a notification or a video in the feed:

- **Video tap** — opens that specific video in YouTube, marks only that video as watched
- **Channel tap** — opens the channel page in YouTube, marks **all** unwatched videos from that channel as watched (bundle clear)

This is the key interaction: video tap for "I've seen this one", channel tap for "I'm going to their channel and clearing my backlog".

### 🏠 Home Feed
- All new videos from tracked channels, newest first
- Unseen videos highlighted with a blue dot
- Thumbnail, title, channel avatar, and publish time
- Tap to open the video directly in YouTube, or jump to the channel page

### 📱 Home Screen Widget
- Android home screen widget showing latest videos
- Compact video rows with thumbnail, title, and channel avatar
- Seen videos dimmed so new uploads stand out
- Tap a row to open the video — no need to open the app

### 🎨 Dark Theme
- Full dark mode with translucent surfaces
- Clean, minimal interface — no clutter, no ads, no recommendations
- Designed for one-handed use

## Architecture

### Overview — v3.0 (channel-first)

```
YouTube RSS feed ──poll every 5 min──▶ Cron Worker ──new videos──▶ API Worker ──FCM push──▶ Phone
  (free, no auth)        │                                       │                       │
                          ▼                                       ▼                       │
                    Cloudflare KV                           YouTube Data API             │
                    (channels:active,                       (subscribe-time only:        │
                     channel meta/recent/subs,               handle→channelId,           │
                     device profile/settings/state/override) avatar fetch — 1-2 units    │
                                                                                       ▼
                                                                                   Phone
                                                                  (also: scheduled events,
                                                                   nag cycle, WebSub dormant)
```

**Key principle:** Channels are the unit of work. Devices are the unit of subscription.  
Every operation asks "what's happening to this channel" first, then "who cares about this channel".  
This inverts the old device-first approach and eliminates `KV.list()` entirely.

**Detection paths in v3:**
- **Active:** Cron Worker polls YouTube's public RSS feed (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) every 5 min, diffs results against `channel:{id}:recent.lastVideoId`, fans out new videos to API Worker. Zero YouTube Data API quota cost.
- **Dormant:** WebSub handlers in both workers exist but the hub is shut down; `/websub` endpoint still works for manual testing or future hub revival
- **YouTube Data API:** reserved for one-time, on-subscribe operations (handle resolve + avatar fetch). ~2 units per new channel added, then 0 forever for that channel.

### API Worker (`tubepulse-api`)

The central Cloudflare Worker. Handles:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register/update device profile. `fcmToken` is optional (null accepted since v3.0.14.1, so a user who denied notification permission can still subscribe channels and use the app). Idempotent — safe to call on every launch and on FCM token refresh. |
| `/subscribe-channel` | POST | Add a channel to this device. Triggers Data API avatar fetch (one-time, cached forever) + RSS bootstrap for the recent list. |
| `/unsubscribe` | POST | Remove a channel from this device. Removes the device from the channel's subscriber list; if the subscriber list goes empty, the channel is removed from the `channels:active` index. |
| `/seen` | POST | Mark videos as watched. `{ channelId, videoIds }` for video tap, `{ channelId, clearAll: true }` for channel tap. |
| `/feed` | GET | Fetch current video data for all tracked channels (reads from KV cache). |
| `/resolve` | GET | Resolve `@handle` → channelId + name + avatar (YouTube Data API, key stays server-side). Result cached 7 days in `handle:{lowercase}`. |
| `/bootstrap` | POST | Fetch RSS + avatar for a newly added channel synchronously. RSS is the primary path; Data API is the fallback for the rare case where RSS is unreachable. |
| `/settings` | POST | Update notification settings (full replacement). |
| `/channel-override` | POST | Set/update per-channel notification override. Empty override deletes it. |
| `/websub` | GET | WebSub verification handshake — **dormant**, responds with `hub.challenge` if any verification request ever arrives. |
| `/websub` | POST | WebSub push from YouTube — **dormant**, code path intact for future hub revival or self-hosted hub integration. |

**Per-request flow (`/subscribe-channel` example):**
1. Look up the device profile (from `Authorization: Bearer <deviceId>`) — must exist
2. Read channel meta from KV; if missing, fetch avatar via YouTube Data API (1 quota unit, cached forever)
3. Read channel recent from KV; if missing, fetch RSS feed (0 quota cost, cached with view counts)
4. Add `deviceId` to the channel's `subscribers` list (if not already there)
5. Add `channelId` to the device's `channels` list (if not already there)
6. Add `channelId` to `channels:active` (if this is the first subscriber)
7. Return the channel meta + recent videos to the app

**YouTube Data API usage:** Only for one-time operations on add: handle→channelId resolve (cached 7 days) and avatar fetch (cached forever). All video detection is via RSS polling in the cron worker. Zero Data API calls from the cron, zero from the FCM push path.

### Cron Worker (`tubepulse-cron`)

Runs every 5 minutes. Four jobs:

#### Job 1: Upcoming Events

Scans time-bucketed `upcoming:` keys for scheduled livestreams going live in the next 30 min.

#### Job 2: YouTube RSS Polling — **active new-video detection**

Iterates `channels:active` and fetches `https://www.youtube.com/feeds/videos.xml?channel_id=...` for each. Parses the Atom feed (videoId, title, publishedAt, thumbnail, link, **and views** from `media:community/media:statistics/@_views`). Diffs against `channel:{channelId}:recent` to find new videoIds. For each new video, looks up subscribers and writes an entry to the API Worker for fan-out to FCM.

Cost: 0 YouTube Data API quota units. RSS is a free, public feed (no auth, no key). Cloudflare KV cost: ~1 read per channel per tick, with writes only when view counts change or a new video is detected.

#### Job 3: Nag Cycle

Scans time-bucketed `nag:` keys for unwatched videos that need re-notifying:

1. For each nag entry, read device profile + settings + per-channel override
2. Skip if DND is active (global or per-channel)
3. Re-validate against current `device:{id}:state:{channelId}.unwatched` — if the user has since marked videos as seen, drop them from the batch
4. Send FCM push, update nag state in KV
5. Schedule the next nag into the appropriate bucket (chill: +4h, relentless: +nagInterval)

Also acts as a safety net — if the RSS poller missed a new video (RSS unreachable, network error), the nag cycle will eventually surface it once a future tick successfully re-stamps the recent list. The nag cycle itself is bucket-driven from the `nag:` keys scheduled by the RSS poller and the upcoming-events cron, not by re-reading `/feed`.

#### Job 4: WebSub Lease Renewal (DORMANT)

WebSub subscriptions would expire (typically 4–10 days) if active. Currently a no-op because Google's `pubsubhubbub.appspot.com` hub has been shut down since 2024. Code path remains so a flip-on is instant if a compatible hub reappears.

### Data Model (Cloudflare KV) — v3.0

| Key Pattern | Contents |
|-------------|----------|
| `channel:{channelId}:meta` | Channel name, avatarUrl, lastVideoId, addedAt |
| `channel:{channelId}:subscribers` | Array of deviceIds tracking this channel |
| `channel:{channelId}:websub` | WebSub state: leaseExpiresAt, hmacSecret, lastVerified (dormant — no longer used) |
| `channel:{channelId}:recent` | Last 15 videos: videoId, title, publishedAt, type, thumbnail, link, **views** (from RSS `media:statistics`), **viewsLastCheckedHour** (wall-clock hour of last view-count refresh) |
| `device:{deviceId}:profile` | fcmToken (nullable), platform, appVersion, createdAt, lastSeenAt |
| `device:{deviceId}:settings` | mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, tapAction, etc. |
| `device:{deviceId}:channels` | Array of channelIds this device tracks |
| `device:{deviceId}:override:{channelId}` | Per-channel overrides: mode?, nagInterval?, dndBypass?, muted? |
| `device:{deviceId}:state:{channelId}` | Per-device per-channel state: unwatched[], lastNagAt, nagCount |
| `upcoming:{bucket}` | Scheduled event entries for a 5-min window (heads-up + live-now entries) |
| `nag:{bucket}` | Nag entries for a 15-min window |
| `channels:active` | Index of all channels with at least one subscriber |
| `handle:{lowercase}` | Cached handle→channelId resolution (7-day TTL) |

**Zero `KV.list()` calls.** The `channels:active` index replaces all list operations.

### App → Server Communication

1. **On launch**: `POST /register` with FCM token (null if notification permission denied) — creates/updates device profile
2. **On channel add**: `POST /subscribe-channel` with channelId → Data API avatar fetch (one-time) + RSS bootstrap
3. **On channel remove**: `POST /unsubscribe` with channelId → device removed from channel's subscriber list
4. **On settings change**: `POST /settings` with updated settings (app uses `notificationMode` UX name, server stores as `mode`)
5. **On per-channel override**: `POST /channel-override` with channelId + override (or empty to clear)
6. **On notification tap**:
   - Video tap → `POST /seen { channelId, videoIds: [id] }`
   - Channel tap → `POST /seen { channelId, clearAll: true }`
7. **On feed refresh**: `GET /feed` → returns cached data from KV, merged with per-device `lastSeen` to compute which videos are `unwatched`
8. **On FCM token refresh**: `POST /register` with the new token (handled by `onTokenRefresh` in App.js)

**Device identity:** Each device generates a persistent UUID on first launch. This UUID is the auth token and primary key — independent of the FCM token, which is stored as a mutable field on the device record and updated on token refresh. This avoids orphan records when FCM tokens rotate.

### Notification Flow

```
Video uploaded on YouTube
         │
         ▼
Cron Worker polls YouTube RSS feed every 5 min
(via https://www.youtube.com/feeds/videos.xml?channel_id=...)
         │
         ▼
Diff against channel:{id}:recent → new videoIds found
         │
         ▼
For each new video, look up channel:{id}:subscribers
         │
         ├─ Video type is 'live_scheduled' (future publishedAt)?
         │     → schedule into upcoming:{bucket} (heads-up at -30min, live-now at +0)
         │     → DO NOT push immediately
         │
         ├─ DND active for this device?
         │     → New videos: livestreams bypass DND by default
         │     → Upcoming-event heads-up + nag cycle: only bypass if dndBypass is set
         │
         ▼
Device receives notification
         │
         ├─ User taps (video) → mark seen, open video
         ├─ User taps (channel) → clear all, open channel
         ├─ User ignores → nag cycle re-notifies on schedule
         │
         ▼
Nag Cycle (every 15 min, scheduled into nag:{bucket} keys)
         │
         ├─ Relentless: re-nag if nagInterval elapsed
         ├─ Chill: nudge if 4h elapsed
         ├─ DND active (no dndBypass)? → skip
         ├─ Video seen? → drop from batch
         │
         ▼
Repeat until user watches
```

The RSS poller is the active new-video detection path since the WebSub hub shutdown in 2024. The WebSub handlers in the workers are dormant but intact.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo |
| Navigation | React Navigation (native stack) |
| Storage | AsyncStorage (channels, settings, cache) |
| Push Detection | YouTube RSS feed poller (cron-driven, 5 min). YouTube Data API is reserved for subscribe-time only (handle resolve + avatar fetch). |
| Video Data | YouTube RSS/Atom feeds (parsed from RSS poll in the cron worker every 5 min) |
| API | YouTube Data API v3 (handle resolution + avatars only) |
| Backend | Cloudflare Workers (API + Cron) |
| Database | Cloudflare KV (devices, feeds, subscriptions) |
| Notifications | Firebase Cloud Messaging (FCM) via HTTP v1 API |
| Widgets | react-native-android-widget |
| Auth | Persistent device UUID (Bearer token, independent of FCM token rotation) |

## Project Structure

```
TubePulse/
├── src/
│   ├── screens/
│   │   ├── HomeScreen.js          # Main feed — new videos from all channels
│   │   ├── ChannelsScreen.js      # Add/remove/reorder channels, per-channel settings
│   │   └── SettingsScreen.js      # Nag interval, notification mode, DND, tap action
│   ├── components/
│   │   ├── TubePulseWidget.js     # Android home screen widget
│   │   ├── widgetTaskHandler.js   # Widget render handler — reads from AsyncStorage
│   │   └── TimeSpinner.js         # DND time picker
│   ├── utils/
│   │   ├── api.js                 # REST client for the Cloudflare Worker (v3 endpoints)
│   │   ├── notifications.js       # Android notification channels
│   │   ├── fcm.js                 # Firebase Cloud Messaging setup + handlers
│   │   ├── storage.js             # AsyncStorage wrapper
│   │   └── constants.js           # Colours, defaults, nag intervals, storage keys, preseeded channels
│   └── App.js                     # Navigation, FCM setup, notification tap handling, init
├── worker/
│   ├── README.md                  # Cloud architecture — KV schema, endpoints, cost analysis
│   ├── index.js                   # Legacy single-worker file (not deployed)
│   ├── wrangler.toml              # Legacy wrangler config
│   ├── tubepulse-api/
│   │   ├── index.js               # API Worker — v3 channel-first architecture
│   │   └── wrangler.toml
│   └── tubepulse-cron/
│       ├── index.js               # Cron Worker — time-bucket driven (upcoming/nag/lease)
│       └── wrangler.toml
├── secrets/                       # All gitignored — live credentials only
│   ├── README.md                  # Operator docs for secrets
│   ├── cloudflare.env             # CF account ID + API token
│   ├── youtube.env                # YouTube Data API key
│   ├── fcm-service-account.json   # Firebase service account (1217-byte PKCS8)
│   ├── load-secrets.sh            # Sources env + generates per-worker .dev.vars
│   └── set-worker-secrets.sh      # Pushes secrets to workers via wrangler
├── ARCHITECTURE.md                # v3 architecture specification
├── STATUS.md                      # Project status and version history
├── MIGRATION_PLAN.md              # v1→v2→v3 migration plan (historical record)
├── build-and-release.sh           # WSL-native build: gradle + commit + push + GitHub release
├── app.json                       # Expo config
├── package.json
└── .gitignore
```

## Settings Reference

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `tapAction` | `video` / `channel` | `video` | What happens when you tap a notification or feed item |
| `notificationMode` | `chill` / `relentless` | `chill` | Chill = nudge every 4h; Relentless = re-nag every interval |
| `nagInterval` | 5 / 15 / 30 / 60 / 120 | 15 | Minutes between nag attempts for unwatched videos |
| `dndEnabled` | boolean | false | Block all notifications during DND hours |
| `dndStart` | HH:MM | 22:00 | DND start time |
| `dndEnd` | HH:MM | 07:00 | DND end time |
| `dndTimezone` | IANA tz string | device's local tz | IANA timezone used to evaluate DND (e.g. `Europe/London`). Without this, the worker would evaluate DND in UTC and notifications would fire at the wrong local time. Sent automatically by the app via `getLocalTimezone()`. |
| `perChannelNotifications` | boolean | false | Enable per-channel notification overrides |
| `includeCommunityPosts` | boolean | false | Placeholder — not detectable via RSS/WebSub yet |

### Per-Channel Overrides

When `perChannelNotifications` is enabled, long-press a channel to configure:
- Notification mode (relentless/chill)
- DND override with custom hours

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npx expo start

# Run on Android
npx expo run:android
```

## Deploying Workers

```bash
# Deploy API worker (handles app traffic + dormant WebSub endpoints)
cd worker/tubepulse-api && npx wrangler deploy

# Deploy cron worker (upcoming events, RSS poll, nag cycle, lease renewal no-op)
cd worker/tubepulse-cron && npx wrangler deploy
```

For the full cloud architecture — KV schema, endpoint reference, FCM details, cost analysis, free tier budget — see **[worker/README.md](worker/README.md)**.

Required Cloudflare secrets:
- `YOUTUBE_API_KEY` — YouTube Data API key (for handle resolution + avatars)
- `FIREBASE_SERVICE_ACCOUNT` — Firebase service account JSON (for FCM)
- `TUBEPULSE_KV` — KV namespace binding (shared between workers)

## Why TubePulse?

YouTube's subscription feed is broken. It mixes in recommendations, buries creators you follow, and the bell notification is unreliable. TubePulse does one thing: **tell you when someone you follow uploads**. No more, no less.

## License

Private project. All rights reserved.