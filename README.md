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
TubePulse detects new uploads via a **YouTube Data API poller** running on a Cloudflare Worker cron (every 5 min). Originally it used **WebSub** (PubSubHubbub) for push-style detection, but Google's `pubsubhubbub.appspot.com` hub was shut down in 2024, so the cron polls `videos.list?channelId=...&order=date` for each tracked channel and diffs against the cached recent list.

**Active path (since 2024):**
- **Polling-based** — cron hits the YouTube Data API every 5 min for every channel with at least one subscriber
- **Cheap to operate** — 1 quota unit per channel per tick (~28,800/day at 100 channels, free tier is 10,000/day)
- **Latency** — up to 5 min between upload and detection
- **Quota-aware** — at scale beyond ~35 channels, the bound becomes API quota, not architecture

**WebSub (dormant):** the `/websub` endpoints and handler code remain in the workers for:
- Manual testing
- Future YouTube-compatible hub revival
- Self-hosted hub integration

When a new video is detected, the worker pushes it to all eligible devices via FCM. New videos appear within 5 minutes of upload. WebSub leases would expire (typically 5 days), so a cron job would renew subscriptions 24 hours before expiry if the hub were active. The last device to remove a channel would trigger an unsubscribe.

**Scheduled event detection:** YouTube Data API entries with a future `publishedAt` are treated as scheduled livestreams/premieres:
- Stored silently when detected — no immediate notification
- **"Going live soon"** notification sent 1 nag interval before the scheduled start
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
- **DND batching** — when DND ends and multiple videos are pending, TubePulse sends a single batched summary (e.g. "3 new videos from 2 channels") instead of flooding you with individual notifications.

When a WebSub push arrives, TubePulse immediately notifies all eligible devices (unless DND is active). The nag cycle then handles re-notifications on the user's chosen schedule.

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
YouTube Data API ──poll every 5 min──▶ Cron Worker ──new videos──▶ API Worker ──FCM push──▶ Phone
                                                      │                                       │
                                                      ▼                                       │
                                                Cloudflare KV                                  │
                                                (channels:active,                              │
                                                 channel meta/recent/subs,                     │
                                                 device profile/settings/state/override)       │
                                                                                               │
                                                                                               ▼
                                                                                          Phone
                                                                          (also: scheduled events,
                                                                           nag cycle, WebSub dormant)
```

**Key principle:** Channels are the unit of work. Devices are the unit of subscription.  
Every operation asks "what's happening to this channel" first, then "who cares about this channel".  
This inverts the old device-first approach and eliminates `KV.list()` entirely.

**Detection paths in v3:**
- **Active:** Cron Worker polls YouTube Data API every 5 min, diffs results against `channel:{id}:recent.lastVideoId`, fans out new videos to API Worker
- **Dormant:** WebSub handlers in both workers exist but the hub is shut down; `/websub` endpoint still works for manual testing or future hub revival

### API Worker (`tubepulse-api`)

The central Cloudflare Worker. Handles:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register/update device profile (FCM token). Idempotent — safe to call on every launch. |
| `/subscribe-channel` | POST | Add a channel to this device. Triggers WebSub subscribe + bootstrap for new channels. |
| `/unsubscribe` | POST | Remove a channel from this device. Triggers WebSub unsubscribe if last subscriber. |
| `/seen` | POST | Mark videos as watched. `{ channelId, videoIds }` for video tap, `{ channelId, clearAll: true }` for channel tap. |
| `/feed` | GET | Fetch current video data for all tracked channels (reads from KV cache). |
| `/resolve` | GET | Resolve `@handle` → channelId + name + avatar (YouTube Data API, key stays server-side). |
| `/bootstrap` | POST | Fetch RSS + avatar for a newly added channel synchronously. |
| `/settings` | POST | Update notification settings (full replacement). |
| `/channel-override` | POST | Set/update per-channel notification override. Empty override deletes it. |
| `/websub` | GET | WebSub verification handshake — responds with `hub.challenge`. |
| `/websub` | POST | WebSub push from YouTube — parses Atom XML, updates recent list, sends FCM notifications, schedules nag. |

**WebSub push handling:**
1. Parse incoming Atom XML for video entries
2. Compare latest video ID against stored state to detect truly new videos
3. Update channel meta and feed cache in KV
4. Scan all registered devices for those tracking this channel
5. For each device: check if video is already seen, check DND, check notification mode
6. Send FCM push to eligible devices, store nag/gentle state for re-notification

**YouTube API usage:** Only for channel avatar fetch at add time (`/register` and `/channels` when a new channel is added). One API call per channel, ever. All video detection is via WebSub/RSS.

### Cron Worker (`tubepulse-cron`)

Runs every 5 minutes. Four jobs:

#### Job 1: Upcoming Events

Scans time-bucketed `upcoming:` keys for scheduled livestreams going live in the next 30 min.

#### Job 2: YouTube Data API Polling — **active new-video detection**

Iterates `channels:active` and calls `videos.list?part=snippet&channelId=...&order=date&maxResults=15` for each. Diffs the response against `channel:{channelId}:recent` to find new videoIds. For each new video, looks up subscribers and writes an entry to the API Worker for fan-out to FCM.

Cost: 1 YouTube Data API quota unit per channel per 5-min tick. Fits in the 10K free tier up to ~35 channels.

#### Job 3: Nag Cycle

Scans time-bucketed `nag:` keys for unwatched videos that need re-notifying:

1. For each nag entry, read device profile + settings + per-channel override
2. Skip if DND is active (global or per-channel)
3. Send FCM push, update nag state in KV
4. Schedule next nag into the appropriate bucket

Also acts as a safety net — if the YouTube poller missed a new video, the nag cycle will eventually notify the device when it checks the feed.

#### Job 4: WebSub Lease Renewal (DORMANT)

WebSub subscriptions would expire (typically 4–10 days) if active. Currently a no-op because Google's `pubsubhubbub.appspot.com` hub has been shut down since 2024. Code path remains so a flip-on is instant if a compatible hub reappears.

### Data Model (Cloudflare KV) — v3.0

| Key Pattern | Contents |
|-------------|----------|
| `channel:{channelId}:meta` | Channel name, avatarUrl, lastVideoId, addedAt |
| `channel:{channelId}:subscribers` | Array of deviceIds tracking this channel |
| `channel:{channelId}:websub` | WebSub state: leaseExpiresAt, hmacSecret, lastVerified |
| `channel:{channelId}:recent` | Last 15 videos: videoId, title, publishedAt, type, thumbnail, link |
| `device:{deviceId}:profile` | fcmToken, platform, appVersion, createdAt, lastSeenAt |
| `device:{deviceId}:settings` | mode, nagInterval, dndStart, dndEnd, tapAction, etc. |
| `device:{deviceId}:channels` | Array of channelIds this device tracks |
| `device:{deviceId}:override:{channelId}` | Per-channel overrides: mode?, nagInterval?, dndBypass?, muted? |
| `device:{deviceId}:state:{channelId}` | Per-device per-channel state: unwatched[], lastNagAt, nagCount |
| `upcoming:{bucket}` | Scheduled event entries for a 5-min window |
| `nag:{bucket}` | Nag entries for a 15-min window |
| `channels:active` | Index of all channels with at least one subscriber |
| `handle:{lowercase}` | Cached handle→channelId resolution (7-day TTL) |

**Zero `KV.list()` calls.** The `channels:active` index replaces all list operations.

### App → Server Communication

1. **On launch**: `POST /register` with FCM token (profile only)
2. **On channel add**: `POST /subscribe-channel` with channelId → triggers WebSub subscribe + bootstrap
3. **On channel remove**: `POST /unsubscribe` with channelId → triggers WebSub unsubscribe if last subscriber
4. **On settings change**: `POST /settings` with updated settings
5. **On per-channel override**: `POST /channel-override` with channelId + override
6. **On notification tap**:
   - Video tap → `POST /seen { channelId, videoIds: [id] }`
   - Channel tap → `POST /seen { channelId, clearAll: true }`
7. **On feed refresh**: `GET /feed` → returns cached data from KV

**Device identity:** Each device generates a persistent UUID on first launch. This UUID is the auth token and primary key — independent of the FCM token, which is stored as a mutable field on the device record and updated on token refresh. This avoids orphan records when FCM tokens rotate.

### Notification Flow

```
Video uploaded on YouTube
         │
         ▼
Cron Worker polls YouTube Data API every 5 min
(via videos.list?channelId=...&order=date)
         │
         ▼
Diff against channel:{id}:recent → new videoIds found
         │
         ▼
Cron Worker calls API Worker's fan-out with new videos
         │
         ├─ DND active? → skip, nag cycle catches later
         │
         ▼
API Worker sends FCM push to all eligible devices
         │
         ▼
Device receives notification
         │
         ├─ User taps (video) → mark seen, open video
         ├─ User taps (channel) → clear all, open channel
         ├─ User ignores → nag cycle re-notifies on schedule
         │
         ▼
Nag Cycle (every 5 min, scheduled into time buckets)
         │
         ├─ Relentless: re-nag if nagInterval elapsed
         ├─ Chill: nudge if 4h elapsed
         ├─ DND active? → skip
         ├─ Video seen? → stop nagging
         │
         ▼
Repeat until user watches
```

**Note:** The notification flow's WebSub push trigger has been replaced by the cron-based YouTube Data API poller. WebSub handlers in the workers are dormant but intact.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo |
| Navigation | React Navigation (native stack) |
| Storage | AsyncStorage (channels, settings, cache) |
| Push Detection | YouTube Data API poller (cron-driven, 5 min). WebSub handler dormant (hub shut down 2024) |
| Video Data | YouTube RSS/Atom feeds (parsed from WebSub pushes) |
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
│   │   └── TimeSpinner.js        # DND time picker
│   ├── utils/
│   │   ├── api.js                 # REST client for the Cloudflare Worker (v3 endpoints)
│   │   ├── notifications.js      # Android notification channels
│   │   ├── fcm.js                # Firebase Cloud Messaging setup + handlers
│   │   ├── storage.js            # AsyncStorage wrapper
│   │   └── constants.js          # Colours, defaults, nag intervals, storage keys
│   └── App.js                    # Navigation, FCM setup, notification tap handling
├── worker/
│   ├── tubepulse-api/
│   │   ├── index.js              # API Worker — v3 channel-first architecture
│   │   └── wrangler.toml
│   ├── tubepulse-cron/
│   │   ├── index.js              # Cron Worker — time-bucket driven (upcoming/nag/lease)
│   │   └── wrangler.toml
│   └── tubepulse-fcm-service-account.json
├── ARCHITECTURE.md                # v3 architecture specification
├── STATUS.md                      # Project status and version history
├── app.json                       # Expo config
└── package.json
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
# Deploy API worker (handles app traffic + WebSub callbacks)
cd worker/tubepulse-api && npx wrangler deploy

# Deploy cron worker (nag cycle + WebSub lease renewal)
cd worker/tubepulse-cron && npx wrangler deploy
```

Required Cloudflare secrets:
- `YOUTUBE_API_KEY` — YouTube Data API key (for handle resolution + avatars)
- `FIREBASE_SERVICE_ACCOUNT` — Firebase service account JSON (for FCM)
- `TUBEPULSE_KV` — KV namespace binding (shared between workers)

## Why TubePulse?

YouTube's subscription feed is broken. It mixes in recommendations, buries creators you follow, and the bell notification is unreliable. TubePulse does one thing: **tell you when someone you follow uploads**. No more, no less.

## License

Private project. All rights reserved.