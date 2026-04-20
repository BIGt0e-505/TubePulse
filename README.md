# TubePulse

A lightweight YouTube channel tracker for Android. Get notified when your favourite channels upload — no polling, no battery drain.

## How It Works

TubePulse uses **WebSub** (pubsubhubbub) to get instant push notifications from YouTube when a channel uploads. There's no background polling, no foreground service, and no periodic RSS fetching. YouTube tells the server there's new content, and the server pushes a notification to your phone.

1. You subscribe to a YouTube channel
2. The server registers a WebSub subscription with YouTube's hub
3. When the channel uploads, YouTube pushes the update to the server
4. The server sends an FCM push notification to your phone
5. You tap the notification and watch the video

## Features

### Instant Notifications
Get pushed notifications the moment a channel uploads. No delay, no battery drain from polling.

### Two Notification Modes
- **Chill** — One notification when a video drops, then a gentle nudge every 4 hours until you watch it
- **Relentless** — Hammers you every cycle (15/30/60/120 min) until you've watched it. You asked for this.

### Do Not Disturb
Set a DND window (e.g. 22:00–07:00). Notifications are held and delivered when DND ends. Livestream notifications bypass DND by default.

### Per-Channel Overrides
Customize notification behaviour per channel:
- Override mode (chill vs relentless)
- Mute a channel entirely
- Set DND bypass for important channels

### Tap Actions
Choose what happens when you tap a notification:
- **Video** — Opens the video directly (default)
- **Channel** — Opens the channel page on YouTube

### Livestream Alerts
Scheduled livestreams get two notifications:
1. ⏰ "Going live in 30 min" — heads-up before the stream starts
2. 🔴 "Is LIVE" — when the stream begins

Livestream notifications always bypass DND.

### Home Screen Widget
Add a TubePulse widget to your home screen showing channel avatars and new content indicators.

### Video Thumbnails
Each video in the feed shows its YouTube thumbnail for quick identification.

### Channel Cap
Up to 100 channels per device. Each channel is server-side subscribed with its own WebSub lease that auto-renews.

## Pre-Seeded Channels

TubePulse comes with two channels pre-loaded:

- **MattO** (@mattdoesartandstuff) — Anime edits and fanart
- **DND Rebecca AFTG** (@DNDrebeccaAFTG) — D&D content

On first launch, these are subscribed server-side, bootstrapped with RSS data and avatars from the YouTube Data API, and all existing videos are marked as watched. New uploads from that point forward trigger notifications.

## Adding Channels

1. Open the **Channels** screen
2. Type a YouTube handle (e.g. `@MrBeast` or just `MrBeast`)
3. Tap **Add**
4. The server resolves the handle, fetches the channel's RSS feed and avatar, and subscribes via WebSub
5. The channel appears immediately with its name, avatar, and recent videos
6. All existing videos are marked as watched — only new uploads trigger notifications

## Removing Channels

Tap **Remove** on any channel in the Channels screen. This unsubscribes you server-side. If you're the last subscriber, the WebSub subscription is cancelled and the channel's data is cleaned up.

## Architecture

TubePulse v3 uses a **channel-first, server-push** architecture:

- **tubepulse-api** — Cloudflare Worker handling REST API + WebSub webhook
- **tubepulse-cron** — Cloudflare Worker handling scheduled tasks (upcoming events, nags, WebSub lease renewal)
- **Cloudflare KV** — All state stored in KV with a channel-first key schema
- **Firebase Cloud Messaging** — Push notifications via HTTP v1 API

No polling. No foreground service. No background fetch. Zero client-side API calls on a timer.

See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for the full technical details, code references, and event sequences.

## Building & Releasing

```bash
# Normal build
./build-and-release.sh 3.0.7

# Build + clear Cloudflare KV (for clean-install testing)
./build-and-release.sh 3.0.7 --clear-kv
```

The build script:
1. Updates version in app.json
2. Installs npm dependencies
3. Builds a local Android APK via EAS
4. Commits and pushes to GitHub
5. Creates a GitHub release with the APK
6. Deploys both Cloudflare Workers

## Installation

1. Download the APK from the [latest release](https://github.com/BIGt0e-505/TubePulse/releases/latest)
2. Transfer to your Android device (or download directly on phone)
3. Enable "Install from Unknown Sources" if prompted
4. Install and open
5. Grant notification permissions when prompted
6. Pre-seeded channels will appear automatically
7. Add more channels via the Channels screen
8. Long-press home screen → Widgets → TubePulse to add a widget

## Requirements

- Android 8.0+
- Google Play Services (for FCM push notifications)
- Internet connection

## Tech Stack

- **App**: React Native / Expo
- **Backend**: Cloudflare Workers + KV
- **Notifications**: Firebase Cloud Messaging (HTTP v1 API)
- **Push source**: YouTube WebSub (pubsubhubbub)
- **Channel metadata**: YouTube Data API v3 + RSS feeds