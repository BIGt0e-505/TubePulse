# TubePulse

Never miss a video from the creators you actually care about.

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

### ⚡ WebSub Push Detection
TubePulse doesn't poll YouTube. It uses **WebSub** (PubSubHubbub) — YouTube pushes to us the instant a video drops. This means:

- **Zero polling** — no wasted RSS fetches, no battery drain
- **Instant detection** — new videos appear within seconds of upload
- **Infinite scalability** — 1 user or 10,000, same server cost
- **No YouTube API quota** for video detection — Atom feeds only, API reserved for channel avatars

When a channel is added, TubePulse subscribes to its WebSub feed. YouTube sends a verification handshake, then pushes an Atom XML payload whenever new content is published. WebSub leases expire (typically 5 days), so a cron job renews subscriptions 24 hours before expiry. The last device to remove a channel triggers an unsubscribe.

**Known limitation:** YouTube's Atom feed doesn't distinguish Shorts, premieres, or livestreams from regular uploads. However, TubePulse detects **scheduled events** (premieres and scheduled livestreams) by checking if the `<published>` time is in the future. These are handled specially:
- Stored silently when detected — no immediate notification
- **"Going live soon"** notification sent 1 nag interval before the scheduled start
- **"Is live"** notification sent when the scheduled time passes
- Then nagged like any other unwatched video until you watch it

Shorts are currently not filtered — they're treated as regular uploads.

### 🔔 Smart Notifications

TubePulse's notification system is built around **nagging**, not polling. You control how often you're allowed to be nagged about an unwatched video:

- **Nag interval** — 5m / 15m / 30m / 1h / 2h (default 15m)
- **Relentless mode** — re-nag every nag interval until you watch the video
- **Chill mode** — notify once, then nudge every 4 hours until you watch it
- **Per-channel overrides** — set different notification modes and DND per creator
- **DND scheduling** — blocks all pushes during custom silent hours (default 22:00–07:00). Videos that arrive during DND are held and delivered when DND ends by the nag cycle.

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

### Overview

```
YouTube ──WebSub push──▶ API Worker ──FCM push──▶ Phone
                                │
                                ▼
                          Cloudflare KV
                          (devices, feeds,
                           subscriptions)
                                │
                                ▼
                     Cron Worker (5 min)
                     ┌─────────────────┐
                     │ 1. Nag cycle    │ ← re-notify unwatched videos
                     │ 2. WebSub lease │ ← renew expiring subscriptions
                     │    renewal      │
                     └─────────────────┘
```

### API Worker (`tubepulse-api`)

The central Cloudflare Worker. Handles:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register/update device (FCM token + channels + settings). Triggers WebSub subscribe for new channels and fetches avatars via YouTube API on first add. |
| `/channels` | PUT | Update channel list. Subscribes to new channels, unsubscribes from removed ones (if no other device tracks them). |
| `/settings` | PUT | Update notification settings (nag interval, mode, DND, per-channel overrides). |
| `/seen` | POST | Mark videos as watched. `{ handle, videoIds }` for video tap, `{ handle, clearAll: true }` for channel tap. |
| `/feed` | GET | Fetch current video data for all tracked channels (reads from KV cache). |
| `/resolve` | GET | Resolve `@handle` → channelId + name + avatar (YouTube Data API, key stays server-side). |
| `/websub` | GET | WebSub verification handshake — responds with `hub.challenge`. |
| `/websub` | POST | WebSub push from YouTube — parses Atom XML, updates feed cache, sends immediate FCM notifications to eligible devices. |

**WebSub push handling:**
1. Parse incoming Atom XML for video entries
2. Compare latest video ID against stored state to detect truly new videos
3. Update channel meta and feed cache in KV
4. Scan all registered devices for those tracking this channel
5. For each device: check if video is already seen, check DND, check notification mode
6. Send FCM push to eligible devices, store nag/gentle state for re-notification

**YouTube API usage:** Only for channel avatar fetch at add time (`/register` and `/channels` when a new channel is added). One API call per channel, ever. All video detection is via WebSub/RSS.

### Cron Worker (`tubepulse-cron`)

Runs every 5 minutes. Two jobs:

#### Job 1: Nag Cycle

Scans all devices for unwatched videos that need re-notifying:

1. List all device keys from KV
2. For each device, for each tracked channel, read the feed from KV
3. For each video in the feed not in the device's `seenIds`:
   - **Relentless**: check if `lastNotifiedAt + nagInterval` has elapsed → re-nag
   - **Chill**: check if `lastRemindedAt + 4h` has elapsed → nudge
4. Skip if DND is active (global or per-channel)
5. Send FCM push, update nag state in KV
6. Prune stale nag states for videos no longer in the feed

Also acts as a safety net — if a WebSub push was missed (e.g. during DND), the nag cycle will eventually notify the device.

#### Job 2: WebSub Lease Renewal

WebSub subscriptions expire (typically 4–10 days). The cron renews any subscription expiring within 24 hours:

1. List all `sub:*` keys from KV
2. Check `leaseExpires` timestamp
3. If expiring within 24h, send a subscribe request to the PubSubHubbub hub
4. The hub sends a GET verification to `/websub`, which updates the lease expiry

### Data Model (Cloudflare KV)

| Key Prefix | Contents |
|-----------|----------|
| `device:<fcmToken>` | Device record: channels, settings, lastSeen (seenIds, nagState, gentleState) |
| `channel:<channelId>` | Channel meta: name, avatar, lastVideoId, lastChecked |
| `feed:<channelId>` | Cached feed: top 5 videos with thumbnails |
| `sub:<channelId>` | WebSub subscription: subscribedAt, leaseExpires |

### App → Server Communication

1. **On launch**: `POST /register` with FCM token, channels, and settings
2. **On channel add**: `PUT /channels` with updated list → triggers WebSub subscribe
3. **On channel remove**: `PUT /channels` → triggers WebSub unsubscribe if no other device tracks it
4. **On settings change**: `PUT /settings` with updated settings
5. **On notification tap**:
   - Video tap → `POST /seen { handle, videoIds: [id] }`
   - Channel tap → `POST /seen { handle, clearAll: true }`
6. **On feed refresh**: `GET /feed` → returns cached data from KV

### Notification Flow

```
Video uploaded on YouTube
         │
         ▼
YouTube sends WebSub push to /websub
         │
         ▼
API Worker parses Atom XML, detects new video
         │
         ├─ DND active? → skip, nag cycle catches later
         │
         ▼
Send FCM push to all eligible devices
         │
         ▼
Device receives notification
         │
         ├─ User taps (video) → mark seen, open video
         ├─ User taps (channel) → clear all, open channel
         ├─ User ignores → nag cycle re-notifies on schedule
         │
         ▼
Nag Cycle (every 5 min)
         │
         ├─ Relentless: re-nag if nagInterval elapsed
         ├─ Chill: nudge if 4h elapsed
         ├─ DND active? → skip
         ├─ Video seen? → stop nagging
         │
         ▼
Repeat until user watches
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo |
| Navigation | React Navigation (native stack) |
| Storage | AsyncStorage (channels, settings, cache) |
| Push Detection | WebSub (PubSubHubbub) via YouTube's hub |
| Video Data | YouTube RSS/Atom feeds (parsed from WebSub pushes) |
| API | YouTube Data API v3 (handle resolution + avatars only) |
| Backend | Cloudflare Workers (API + Cron) |
| Database | Cloudflare KV (devices, feeds, subscriptions) |
| Notifications | Firebase Cloud Messaging (FCM) via HTTP v1 API |
| Widgets | react-native-android-widget |
| Auth | FCM token as device identity (Bearer token) |

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
│   │   ├── api.js                 # REST client for the Cloudflare Worker
│   │   ├── notifications.js      # Android notification channels
│   │   ├── fcm.js                # Firebase Cloud Messaging setup + handlers
│   │   ├── storage.js            # AsyncStorage wrapper + pollInterval→nagInterval migration
│   │   └── constants.js          # Colours, defaults, nag intervals, storage keys
│   └── App.js                    # Navigation, FCM setup, notification tap handling
├── worker/
│   ├── tubepulse-api/
│   │   ├── index.js              # API Worker — app endpoints + WebSub callback
│   │   └── wrangler.toml
│   ├── tubepulse-cron/
│   │   ├── index.js              # Cron Worker — nag cycle + WebSub lease renewal
│   │   └── wrangler.toml
│   └── tubepulse-fcm-service-account.json
├── app.json                       # Expo config
└── package.json
```

## Settings Reference

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `tapAction` | `video` / `channel` | `video` | What happens when you tap a notification or feed item |
| `notificationMode` | `relentless` / `chill` | `relentless` | Relentless = re-nag every interval; Chill = nudge every 4h |
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