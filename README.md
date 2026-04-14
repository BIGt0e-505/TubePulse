# TubePulse

Never miss a video from the creators you actually care about.

TubePulse is a lightweight YouTube tracker for Android that monitors your favourite channels and notifies you the moment they upload. No algorithm, no recommendations, no rabbit holes — just a clean list of who's posted what, in the order they posted it.

## Features

### 📺 Channel Tracking
- Add channels by handle (`@handle`) — no URLs, no pasting video links
- Auto-resolves handles to channel IDs via YouTube's internal API
- Draggable channel list — reorder by priority
- Per-channel avatars and video counts cached locally
- Pre-seeded with MattO and DND Rebecca AFTG (remove or add your own)

### 🔔 Smart Notifications
- **Relentless mode** — notify on every new video, no filtering
- **Chill mode** — one notification per channel, then marks as seen
- **Per-channel overrides** — set different notification modes per creator
- **DND scheduling** — silent hours with custom start/end times (default 22:00–07:00)
- **Silent channels** — mute notifications for a channel without removing it
- Separate Android notification channels for sound vs silent

### 🏠 Home Feed
- All new videos from tracked channels, newest first
- Unseen videos highlighted with a blue dot
- Thumbnail, title, channel avatar, view count, and publish time
- Tap to open the video directly in YouTube, or jump to the channel page

### 📱 Home Screen Widget
- Android home screen widget showing latest videos
- Compact video rows with thumbnail, title, and channel avatar
- Seen videos dimmed so new uploads stand out
- Tap a row to open the video — no need to open the app

### ⚙️ Background Polling
- Configurable poll intervals: 5, 15, 30, 60, or 120 minutes
- Uses Android's background fetch API for battery efficiency
- Smart caching — only fetches RSS feeds for channels that might have new content
- Handles YouTube's EU cookie consent wall automatically

### 🎨 Dark Theme
- Full dark mode with translucent surfaces
- Clean, minimal interface — no clutter, no ads, no recommendations
- Designed for one-handed use

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo |
| Language | TypeScript |
| Navigation | React Navigation (bottom tabs + native stack) |
| Storage | AsyncStorage (channels, settings, cache) |
| RSS | YouTube RSS feeds + fast-xml-parser |
| Notifications | Expo Notifications + Android channels |
| Widgets | react-native-android-widget |
| Background | Expo Background Fetch + TaskManager |
| HTTP | fetch with timeout + consent cookie bypass |

## Project Structure

```
TubePulse/
├── src/
│   ├── screens/
│   │   ├── HomeScreen.js        # Main feed — new videos from all channels
│   │   ├── ChannelsScreen.js     # Add/remove/reorder channels, per-channel settings
│   │   └── SettingsScreen.js    # Poll interval, notification mode, DND, widget
│   ├── components/
│   │   └── TubePulseWidget.js   # Android home screen widget
│   ├── utils/
│   │   ├── rss.js               # YouTube RSS fetching + channel resolution
│   │   ├── notifications.js     # Notification scheduling, DND logic, channels
│   │   ├── storage.js           # AsyncStorage wrapper for all persistent data
│   │   ├── backgroundTask.js   # Background fetch registration + polling
│   │   └── constants.js         # Colours, defaults, storage keys
│   └── App.js                  # Navigation setup, fonts, theming
├── app.json                     # Expo config
└── package.json
```

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npx expo start

# Run on Android
npx expo run:android
```

## How It Works

1. **Add a channel** by its YouTube handle (e.g. `@mkbhd`)
2. TubePulse resolves the handle to a channel ID using YouTube's internal API (bypassing the consent wall)
3. It fetches the channel's RSS feed to get the latest videos
4. In the background, it polls at your chosen interval (5–120 min)
5. When a new video appears, it sends a notification with the channel name and video title
6. Tapping the notification or the video in the feed opens it directly in YouTube

## Why TubePulse?

YouTube's subscription feed is broken. It mixes in recommendations, buries creators you follow, and the bell notification is unreliable. TubePulse does one thing: **tell you when someone you follow uploads**. No more, no less.

## License

Private project. All rights reserved.