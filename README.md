# TubePulse

> Current repo status: see [STATUS.md](STATUS.md). The app version in this repo is `3.2.4` (`app.json`, `android/app/build.gradle`). Historical planning docs are not authoritative for current release/deployment state.
> App release process and cleanup plan: see [RELEASE.md](RELEASE.md). Worker deployments are separate from app APK releases.

Never miss a video from the creators you actually care about. **Android only.**

TubePulse is a lightweight YouTube tracker for Android that monitors your favourite channels and notifies you the moment they upload. No algorithm, no recommendations, no rabbit holes — just a clean list of who's posted what, in the order they posted it.

## Current App Line
The current checked-in app version is `3.2.4`. The v3.1 feature line below remains the latest broad feature summary in these docs; see [STATUS.md](STATUS.md) for current repo status and caveats.

- **Like & dislike counts in the video card meta row** — shown next to the publish time and view count, so you can see what the community thinks of a video at a glance.
- **📝 Community posts in the feed** — channel community posts (text, images, polls) are now polled hourly and rendered in the home feed under a "Posts" mini-header. Posts have their own blue dot for unseen items, get marked as seen like videos, and respect the same global + per-channel opt-out settings.
- **⏰ Prewarn time for scheduled livestreams** — pick how early you want to be notified before a scheduled livestream goes live (15m, 30m, 1h, 2h, 4h, or 1d — default 1h). Per-channel override available. At the moment the livestream actually goes live, the regular new-video notification fires; the prewarn is the heads-up, the regular push is the "this just appeared" notification.
- **🗨️ Custom ConfirmDialog** — replacing `Alert.alert` for the channel-removal confirmation. Themed to match the rest of the app (`COLORS.surface` background, `COLORS.danger` for the destructive action).

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
- **Includes view counts, likes & dislikes** — RSS carries `media:statistics/@_views`, `media:starRating/@_count` (likes), and `media:statistics/@_dislikes` (usually `0` since YouTube removed public dislike counts in Nov 2021, but the field is still captured)
- **The YouTube Data API is reserved for subscribe-time only** — handle→channelId resolve (1 unit, cached 7 days) and avatar fetch (1 unit per new channel, cached forever). The community-posts polling in v3.1 is the only other API consumer (1 unit/channel/hour, ~100 units/day for 4 channels).

**WebSub (dormant):** the `/websub` endpoints and handler code remain in the workers for:
- Manual testing
- Future YouTube-compatible hub revival
- Self-hosted hub integration

When a new video is detected, the worker pushes it to all eligible devices via FCM. New videos appear within 5 minutes of upload. WebSub leases would expire (typically 5 days), so a cron job would renew subscriptions 24 hours before expiry if the hub were active. The last device to remove a channel would trigger an unsubscribe.

**Scheduled event detection (v3.1):** RSS entries with a future `publishedAt` are treated as scheduled livestreams/premieres:
- Stored silently when detected — no immediate notification
- **Prewarn push** fired at the user's chosen offset (default 1h, options 15m–1d) before the scheduled start. Body shows the actual remaining time so the user sees accurate information even if the cron is a few minutes late.
- **At the scheduled time, the regular new-video push fires** — the same `type: 'live'` notification as any other upload. There is no separate "is live now!" notification; the prewarn is the heads-up, the regular push is the "this just appeared" notification. Livestreams bypass DND.
- Then nagged like any other unwatched video until you watch it

**Community posts (v3.1):** a separate cron job polls YouTube's Data API `activities.list` once per hour per active channel. Captures text posts, image posts, and polls. First-run guard prevents notification floods on first install. Posts respect the same global `includeCommunityPosts` setting and per-channel override as videos. Posts do not enter the nag cycle — only the initial push fires.

Shorts are currently not filtered — they're treated as regular uploads.

### 🔔 Smart Notifications

TubePulse's notification system is built around **nagging**, not polling. You control how often you're allowed to be nagged about an unwatched video:

- **Nag interval** — 5m / 15m / 30m / 1h / 2h (default 15m)
- **Chill mode** (default) — notify once, then nudge every 4 hours until you watch it
- **Relentless mode** — re-nag every nag interval until you watch the video
- **Per-channel overrides** — set different notification modes, DND, prewarn time, and post opt-out per creator
- **DND scheduling** — blocks non-livestream pushes during custom silent hours (default 22:00–07:00). Livestreams (`type: 'live'`) bypass DND by default; regular new-video, prewarn, and post pushes respect DND unless the per-channel override sets `dndBypass: true`. Videos that arrive during DND are held and delivered when DND ends by the nag cycle.
- **DND batching** — when DND ends and multiple unwatched videos are pending for the same channel, TubePulse sends a single per-channel summary (e.g. `ChannelName - 3 unwatched`) instead of flooding you with individual notifications. The batch groups by channel — you'll get one notification per channel with its unwatched count, not one per video.

When the RSS poller detects a new video (every 5 min), TubePulse immediately notifies all eligible devices (unless DND is active). The nag cycle then handles re-notifications on the user's chosen schedule.

### 👆 Tap Actions — Video vs Channel

When you tap a notification or a video in the feed:

- **Video tap** — opens that specific video in YouTube, marks only that video as watched
- **Channel tap** — opens the channel page in YouTube, marks **all** unwatched videos and posts from that channel as watched (bundle clear)

This is the key interaction: video tap for "I've seen this one", channel tap for "I'm going to their channel and clearing my backlog".

### 🏠 Home Feed
- All new videos and community posts from tracked channels, newest first
- Unseen videos and posts highlighted with a blue dot
- Video rows: thumbnail, title, channel avatar, meta row (age · likes · dislikes · views)
- Post rows: thumbnail OR speech-bubble placeholder (greyscale shrunk channel avatar inside a rounded-rect bubble with a small triangular tail), header ("Posted" / "Posted an image" / "Posted a poll"), truncated body (3 lines)
- Tap a video to open it in YouTube; tap a post to open the channel's community tab
- Long-press a video to copy its link

### 📱 Home Screen Widget
- Android home screen widget showing latest videos and community posts
- Compact rows with thumbnail, title, channel avatar, and post cards
- Seen items dimmed so new uploads stand out
- Tap video to open in YouTube, tap pfp to open channel, tap post to open community tab
- Respects `tapAction` setting (channel mode sends all taps to the channel)

### 🎨 Dark Theme
- Full dark mode with translucent surfaces
- Clean, minimal interface — no clutter, no ads, no recommendations
- Designed for one-handed use

## Architecture

### Overview - Current Repo Evidence

```
YouTube RSS feed ──poll every 5 min──▶ Cron Worker ──new videos──▶ API Worker ──FCM push──▶ Phone
  (free, no auth)        │                                       │                       │
                          │                                       │   ┌── prewarn push   │
                          │                                       │   │  (per-device,    │
                          │                                       │   │   5-min tick)    │
                          ▼                                       │   │                  │
                    Cloudflare KV                           YouTube Data API             │
                    (channels:active,                       (subscribe-time:             │
                     channel meta/recent/subs/               handle→channelId,            │
                     channel recent:posts,                  avatar; posts cron:           │
                     device profile/settings/state/override) activities.list/hour)        │
                                                                                       ▼
                                                                                   Phone
                                                                  (also: nag cycle, WebSub dormant)
```

**Verified API route:** as of 2026-06-25, `GET /` on `https://tubepulse-api.jimothyoakley55.workers.dev` returns Cloudflare-served health JSON identifying `worker: "tubepulse-api"` and `architecture: "channel-first"`. The health JSON reports `version: "3.0.0"`; keep that separate from the app version `3.2.4`. The wrangler config comment saying no HTTP routes is stale/incomplete, so review Cloudflare settings before changing routing.

**Key principle:** Channels are the unit of work. Devices are the unit of subscription.  
Every operation asks "what's happening to this channel" first, then "who cares about this channel".  
This inverts the old device-first approach and eliminates `KV.list()` entirely.

**Detection paths in v3.1:**
- **Active (videos):** Cron Worker polls YouTube's public RSS feed every 5 min, diffs against `channel:{id}:recent.lastVideoId`, fans out new videos via the API Worker. Zero Data API quota cost.
- **Active (posts, v3.1):** Cron Worker polls `activities.list` every hour per active channel. ~1 unit/channel/hour, ~100 units/day for 4 channels.
- **Active (prewarn, v3.1):** Cron Worker iterates the global `upcoming:events:list` every 5 min and fires per-device prewarn pushes when each device's prewarn window is active.
- **Dormant:** WebSub handlers in both workers exist but the hub is shut down; `/websub` endpoint still works for manual testing or future hub revival.
- **YouTube Data API:** reserved for one-time subscribe-time operations (handle resolve + avatar fetch) and the posts cron. The v3.0 cron and FCM push paths consume zero Data API quota.

### API Worker (`tubepulse-api`)

This is the current live app-facing API worker. The app client points to `https://tubepulse-api.jimothyoakley55.workers.dev`, and live `GET /` verification on 2026-06-25 returned the worker health JSON. `worker/tubepulse-api/wrangler.toml` still has a stale/incomplete route comment, so do not use that comment alone for cleanup decisions.
The central Cloudflare Worker. Handles:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register/update device profile. `fcmToken` is optional (null accepted so a user who denied notification permission can still subscribe channels and use the app). Idempotent — safe to call on every launch and on FCM token refresh. |
| `/subscribe-channel` | POST | Add a channel to this device. Triggers Data API avatar fetch (one-time, cached forever) + RSS bootstrap for the recent list. |
| `/unsubscribe` | POST | Remove a channel from this device. Removes the device from the channel's subscriber list; if the subscriber list goes empty, the channel is removed from the `channels:active` index. |
| `/seen` | POST | Mark videos/posts as watched. `{ channelId, ids: [videoId, "post:activityId", ...] }` for taps, `{ channelId, clearAll: true }` for channel-tap. Post IDs are namespaced with `post:` so they share the `deviceState.unwatched` array with videos without collision. |
| `/feed` | GET | Fetch current video + post data for all tracked channels (reads from KV cache). Each post carries an `unwatched` flag mirroring the video pattern. |
| `/resolve` | GET | Resolve `@handle` → channelId + name + avatar (YouTube Data API, key stays server-side). Result cached 7 days in `handle:{lowercase}`. |
| `/bootstrap` | POST | Fetch RSS + avatar for a newly added channel synchronously. RSS is the primary path; Data API is the fallback for the rare case where RSS is unreachable. |
| `/settings` | POST | Update notification settings (full replacement). Includes `prewarnMinutes` (v3.1). |
| `/channel-override` | POST | Set/update per-channel notification override. Empty override deletes it. Supports `prewarnMinutes` and `includeCommunityPosts` overrides (v3.1). |
| `/websub` | GET | WebSub verification handshake — **dormant**, responds with `hub.challenge` if any verification request ever arrives. |
| `/websub` | POST | WebSub push from YouTube — **dormant**, code path intact for future hub revival or self-hosted hub integration. |

**Per-request flow (`/subscribe-channel` example):**
1. Look up the device profile (from `Authorization: Bearer <deviceId>`) — must exist
2. Read channel meta from KV; if missing, fetch avatar via YouTube Data API (1 quota unit, cached forever)
3. Read channel recent from KV; if missing, fetch RSS feed (0 quota cost, cached with view counts + likes + dislikes)
4. Add `deviceId` to the channel's `subscribers` list (if not already there)
5. Add `channelId` to the device's `channels` list (if not already there)
6. Add `channelId` to `channels:active` (if this is the first subscriber)
7. Return the channel meta + recent videos to the app

**YouTube Data API usage:** Subscribe-time handle→channelId resolve (cached 7 days) and avatar fetch (cached forever). The posts cron consumes ~1 unit/channel/hour. All video detection is via RSS polling in the cron worker. Zero Data API calls from the cron-driven video path or the FCM push path.

### Cron Worker (`tubepulse-cron`)

Runs every 5 minutes. Six jobs:

#### Job 1: Upcoming Events Drain

Reads the current 5-min `upcoming:` bucket and deletes it without firing. Stale pre-v3.1 bucket entries are cleared on the first tick after upgrade, so the old "going live in 30 minutes" / "is live now!" pushes cannot fire for events scheduled before the upgrade. In v3.1 the bucket scheme is dead — the prewarn logic uses `runPrewarnCron` instead.

#### Job 2: Prewarn (per-device, v3.1)

Iterates `upcoming:events:list` and fires per-device "going live soon" pushes when each device's prewarn window is active. The prewarn time is per-device: per-channel override → global setting → default (60 min). Sent state tracked in `upcoming:prewarn:{videoId}:{deviceId}` to prevent double-send. Events pruned 24h after `scheduledFor` with their sent keys cleaned up.

#### Job 3: YouTube RSS Polling — **active new-video detection**

Iterates `channels:active` and fetches `https://www.youtube.com/feeds/videos.xml?channel_id=...` for each. Parses the Atom feed (videoId, title, publishedAt, thumbnail, link, **views** from `media:community/media:statistics/@_views`, **likes** from `media:starRating/@_count`, **dislikes** from `media:statistics/@_dislikes`). Diffs against `channel:{channelId}:recent` to find new videoIds. For each new video, looks up subscribers and writes an entry to the API Worker for fan-out to FCM.

For `type: 'live_scheduled'` entries: append to `upcoming:events:list` (so the prewarn cron can iterate them) but do not write to the `upcoming:` bucket and do not fire any push immediately. The prewarn and live-time pushes are handled separately.

Cost: 0 YouTube Data API quota units. RSS is a free, public feed (no auth, no key). Cloudflare KV cost: ~1 read per channel per tick, with writes only when engagement metrics change or a new video is detected.

#### Job 4: Community Posts (v3.1)

Iterates `channels:active` and polls YouTube's Data API `activities.list` for each. Captures text, image, and poll community posts. First-run guard: on first poll, populates the recent list without firing notifications (no flood on first install or feature enable). New posts are appended to `device:{deviceId}:state:{channelId}.unwatched` (namespaced with `post:`) and trigger an FCM push to subscribers that haven't opted out globally or per-channel. Cost: ~1 unit/channel/hour.

#### Job 5: Nag Cycle

Scans time-bucketed `nag:` keys for unwatched videos that need re-notifying:

1. For each nag entry, read device profile + settings + per-channel override
2. Skip if DND is active (global or per-channel)
3. Re-validate against current `device:{id}:state:{channelId}.unwatched` — if the user has since marked videos as seen, drop them from the batch
4. Send FCM push, update nag state in KV
5. Schedule the next nag into the appropriate bucket (chill: +4h, relentless: +nagInterval)

Also acts as a safety net — if the RSS poller missed a new video (RSS unreachable, network error), the nag cycle will eventually surface it once a future tick successfully re-stamps the recent list. The nag cycle itself is bucket-driven from the `nag:` keys scheduled by the RSS poller and the upcoming-events cron, not by re-reading `/feed`.

**Posts do not enter the nag cycle** — only the initial push fires for posts. The plan did not require post nagging; adding it would need a parallel nag bucket and FCM payload differentiation. Flagged for v3.2.

#### Job 6: WebSub Lease Renewal (DORMANT)

WebSub subscriptions would expire (typically 4–10 days) if active. Currently a no-op because Google's `pubsubhubbub.appspot.com` hub has been shut down since 2024. Code path remains so a flip-on is instant if a compatible hub reappears.

### Data Model (Cloudflare KV) — v3.1

| Key Pattern | Contents |
|-------------|----------|
| `channel:{channelId}:meta` | Channel name, avatarUrl, lastVideoId, addedAt |
| `channel:{channelId}:subscribers` | Array of deviceIds tracking this channel |
| `channel:{channelId}:websub` | WebSub state: leaseExpiresAt, hmacSecret, lastVerified (dormant — no longer used) |
| `channel:{channelId}:recent` | Last 15 videos: videoId, title, publishedAt, type, thumbnail, link, **views** (from RSS `media:statistics/@_views`), **likes** (from `media:starRating/@_count`), **dislikes** (from `media:statistics/@_dislikes`), **viewsLastCheckedHour** (wall-clock hour of last engagement-metric refresh) |
| `channel:{channelId}:recent:posts` | Last 30 community posts: activityId, kind, text, thumbnail, link, publishedAt |
| `channel:{channelId}:firstPollAt:posts` | ISO timestamp of first posts-cron run for this channel (drives the first-run guard) |
| `device:{deviceId}:profile` | fcmToken (nullable), platform, appVersion, createdAt, lastSeenAt |
| `device:{deviceId}:settings` | mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, tapAction, includeCommunityPosts, prewarnMinutes, etc. |
| `device:{deviceId}:channels` | Array of channelIds this device tracks |
| `device:{deviceId}:override:{channelId}` | Per-channel overrides: mode?, nagInterval?, dndBypass?, muted?, includeCommunityPosts? (v3.1, tri-state null/true/false), prewarnMinutes? (v3.1, tri-state null/number) |
| `device:{deviceId}:state:{channelId}` | Per-device per-channel state: unwatched[] (videos by videoId, posts by `post:{activityId}`), lastNagAt, nagCount |
| `upcoming:events:list` | Array of currently-scheduled live events: { channelId, videoId, scheduledFor, addedAt }. Pruned 24h after live. (v3.1) |
| `upcoming:prewarn:{videoId}:{deviceId}` | Set to the prewarnMinutes value when a prewarn push has been sent for that (event, device). Cleaned when the event is pruned. (v3.1) |
| `upcoming:{bucket}` | Pre-v3.1 only — drained by the new `runUpcomingCron` on the first tick after upgrade |
| `nag:{bucket}` | Nag entries for a 15-min window |
| `channels:active` | Index of all channels with at least one subscriber |
| `handle:{lowercase}` | Cached handle→channelId resolution (7-day TTL) |

**Zero `KV.list()` calls.** The `channels:active` index replaces all list operations.

### App → Server Communication

1. **On launch**: `POST /register` with FCM token (null if notification permission denied) — creates/updates device profile
2. **On channel add**: `POST /subscribe-channel` with channelId → Data API avatar fetch (one-time) + RSS bootstrap
3. **On channel remove**: `POST /unsubscribe` with channelId → device removed from channel's subscriber list (with a custom ConfirmDialog confirmation in v3.1)
4. **On settings change**: `POST /settings` with updated settings (app uses `notificationMode` UX name, server stores as `mode`); includes `prewarnMinutes` and `includeCommunityPosts` in v3.1
5. **On per-channel override**: `POST /channel-override` with channelId + override (or empty to clear). Supports `prewarnMinutes` and `includeCommunityPosts` overrides in v3.1, both tri-state (null = inherit, value = override)
6. **On notification tap**:
   - Video tap → `POST /seen { channelId, ids: [id] }`
   - Channel tap → `POST /seen { channelId, clearAll: true }`
   - Post tap (v3.1) → `POST /seen { channelId, ids: ["post:activityId"] }`, then open the channel's community tab
   - Prewarn tap (v3.1) → open the YouTube watch URL for the scheduled video. The video is NOT marked as seen on tap (the prewarn is a reminder; the live-time push will still fire later)
7. **On feed refresh**: `GET /feed` → returns cached data from KV, merged with per-device state to compute `unwatched` flags on both videos and posts
8. **On FCM token refresh**: `POST /register` with the new token (handled by `onTokenRefresh` in App.js)

**Device identity:** Each device generates a persistent UUID on first launch. This UUID is the auth token and primary key — independent of the FCM token, which is stored as a mutable field on the device record and updated on token refresh. This avoids orphan records when FCM tokens rotate.

### Notification Flow

```
Video uploaded on YouTube                              Channel posts on YouTube
         │                                                     │
         ▼                                                     ▼
Cron Worker polls YouTube RSS feed every 5 min       Cron Worker polls YouTube
(via https://www.youtube.com/feeds/videos.xml)        activities.list every hour
         │                                                     │
         ▼                                                     ▼
Diff against channel:{id}:recent → new videoIds       Diff against channel:{id}:recent:posts
         │                                                     │
         ├─ Type 'live_scheduled' (future publishedAt)?       │
         │   → append to upcoming:events:list                 │
         │   → runPrewarnCron will iterate and fire           │
         │     per-device prewarn pushes                      │
         │                                                     │
         ▼                                                     ▼
For each new video, look up channel:{id}:subscribers  For each new post, look up subscribers
         │                                                     │
         ├─ DND active for this device?                       ├─ Global includeCommunityPosts off
         │   → New videos: livestreams bypass DND by default  │  AND no per-channel override?
         │   → Upcoming-event heads-up + nag cycle:           │  → skip
         │     only bypass if dndBypass is set                │
         ▼                                                     ▼
Device receives notification                        Device receives notification
         │                                                     │
         ├─ User taps (video) → mark seen, open video         ├─ User taps (post) →
         ├─ User taps (channel) → clear all, open channel     │  mark post seen, open community tab
         ├─ User ignores → nag cycle re-notifies              ├─ User ignores → no nag (posts don't
         │                                                     │  enter the nag cycle in v3.1)
         ▼                                                     ▼
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
| Push Detection | YouTube RSS feed poller (cron-driven, 5 min). YouTube Data API: posts poller (hourly) + subscribe-time (handle resolve + avatar fetch). |
| Video Data | YouTube RSS/Atom feeds (parsed from RSS poll in the cron worker every 5 min) |
| API | YouTube Data API v3 (handle resolution + avatars + community-posts polling) |
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
│   │   ├── HomeScreen.js          # Main feed — new videos and posts from all channels
│   │   ├── ChannelsScreen.js      # Add/remove/reorder channels, per-channel settings
│   │   └── SettingsScreen.js      # Nag interval, mode, DND, prewarn, posts toggle, tap action
│   ├── components/
│   │   ├── TubePulseWidget.js     # Android home screen widget
│   │   ├── widgetTaskHandler.js   # Widget render handler — reads from AsyncStorage
│   │   ├── TimeSpinner.js         # DND time picker
│   │   ├── ConfirmDialog.js       # Themed modal dialog (v3.1, replaces Alert.alert)
│   │   └── Confirm.js             # Promise-based confirm({...}) helper that renders ConfirmDialog (v3.1)
│   ├── utils/
│   │   ├── api.js                 # REST client for the Cloudflare Worker (v3 endpoints)
│   │   ├── notifications.js       # Android notification channels
│   │   ├── fcm.js                 # Firebase Cloud Messaging setup + handlers
│   │   ├── storage.js             # AsyncStorage wrapper
│   │   └── constants.js           # Colours, defaults, nag intervals, prewarn options, storage keys, preseeded channels
│   └── App.js                     # Navigation, FCM setup, notification tap handling, init
├── worker/
│   ├── README.md                  # Cloud architecture — KV schema, endpoints, cost analysis
│   ├── archive/
│   │   └── tubepulse-resolver/     # Historical standalone resolver worker; reference only
│   ├── tubepulse-api/
│   │   ├── index.js               # API Worker — v3.1 channel-first + posts + prewarn
│   │   └── wrangler.toml
│   └── tubepulse-cron/
│       ├── index.js               # Cron Worker — v3.1 (prewarn + posts + RSS poll + nag + lease)
│       └── wrangler.toml
├── secrets/                       # All gitignored — live credentials only
│   ├── README.md                  # Operator docs for secrets
│   ├── cloudflare.env             # CF account ID + API token
│   ├── youtube.env                # YouTube Data API key
│   ├── fcm-service-account.json   # Firebase service account (1217-byte PKCS8)
│   ├── load-secrets.sh            # Sources env + generates per-worker .dev.vars
│   └── set-worker-secrets.sh      # Pushes secrets to workers via wrangler
├── ARCHITECTURE.md                # v3 architecture specification
├── PLAN_v3.1.md                   # Historical v3.1 implementation plan
├── STATUS.md                      # Current repo status and operational caveats
├── MIGRATION_PLAN.md              # v1→v2→v3 migration plan (historical record)
├── build-and-release.ps1           # Windows-native app release script
├── RELEASE.md                      # Current release process, risks, and target flow
├── app.json                       # Expo config
├── package.json
└── .gitignore
```

## Settings Reference

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `tapAction` | `video` / `channel` | `video` | `video` = tap video opens video, tap pfp opens channel. `channel` = everything opens the channel. Applies to notifications, app feed, and widget. Posts always open community tab regardless. |
| `notificationMode` | `chill` / `relentless` | `chill` | Chill = nudge every 4h; Relentless = re-nag every interval |
| `nagInterval` | 5 / 15 / 30 / 60 / 120 | 15 | Minutes between nag attempts for unwatched videos |
| `dndEnabled` | boolean | false | Block all notifications during DND hours |
| `dndStart` | HH:MM | 22:00 | DND start time |
| `dndEnd` | HH:MM | 07:00 | DND end time |
| `dndTimezone` | IANA tz string | `UTC` | IANA timezone used to evaluate DND (e.g. `Europe/London`). The shipped `DEFAULT_SETTINGS` is `'UTC'`; the app overrides this on first launch via `getLocalTimezone()` (Intl API) and sends it to the server on every `/register` and `/settings`, so by the time DND is actually checked the device's local zone is in use. Without this, the worker would evaluate DND in UTC and notifications would fire at the wrong local time. |
| `perChannelNotifications` | boolean | false | Enable per-channel notification overrides |
| `includeCommunityPosts` | boolean | false | Show channel community posts in your feed (v3.1) |
| `prewarnMinutes` | 15 / 30 / 60 / 120 / 240 / 1440 | 60 | How early to fire a prewarn push before a scheduled livestream (v3.1) |

### Per-Channel Overrides

When `perChannelNotifications` is enabled, long-press a channel to configure:
- Notification mode (relentless/chill)
- DND override with custom hours
- Community posts opt-out (Global / On / Off, v3.1)
- Prewarn time (Override switch + 15m/30m/1h/2h/4h/1d picker, v3.1)

## Known Limitations (v3.1)

- **Posts do not enter the nag cycle.** Only the initial push fires for posts; no 4-hour reminders. Adding it would need a parallel nag bucket and FCM payload differentiation. Flagged for v3.2.

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
# Deploy API worker source (app-facing API in repo; verify live route state first)
cd worker/tubepulse-api && npx wrangler deploy

# Deploy cron worker (prewarn + RSS poll + posts + nag cycle + lease renewal no-op)
cd worker/tubepulse-cron && npx wrangler deploy
```

Before worker cleanup, note that the app's workers.dev API URL is verified reachable, while the repo wrangler comment remains stale/incomplete; review deployed Cloudflare settings before route/config changes.

For the full cloud architecture — KV schema, endpoint reference, FCM details, cost analysis, free tier budget — see **[worker/README.md](worker/README.md)**.

Required Cloudflare secrets:
- `YOUTUBE_API_KEY` — YouTube Data API key (for handle resolution + avatars + posts polling)
- `FIREBASE_SERVICE_ACCOUNT` — Firebase service account JSON (for FCM)
- `TUBEPULSE_KV` — KV namespace binding (shared between workers)

## Why TubePulse?

YouTube's subscription feed is broken. It mixes in recommendations, buries creators you follow, and the bell notification is unreliable. TubePulse does one thing: **tell you when someone you follow uploads**. No more, no less.

## License

Private project. All rights reserved.
