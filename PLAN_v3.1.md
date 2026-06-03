# v3.1 Plan — Likes, Community Posts, Prewarn, Custom Dialog

This file is the canonical plan for the v3.1 release. **Update it as items are
completed** — if we get sidetracked or run out of context, this file lets
us resume cleanly.

## Scope

Four user-facing features, in priority order:

1. **Likes + dislikes in the video card meta row** — greyscale minimalist
   thumb-up icon, likes count, thumb-down icon, dislikes count, all in
   the same row as age and view count. Polled at the same rate as view
   count (throttled per the existing view-count policy: latest video
   only, hourly, 5% threshold).
2. **Community posts via YouTube Data API** — `activities.list` polled
   hourly per channel, throttled to 1 call/hour. Notification text
   indicates it's a post. Post card in home feed: thumbnail if
   available, otherwise a **large speech-bubble placeholder with a
   greyscale shrunk channel avatar** in the same 16:9 aspect as video
   thumbnails. Posts are opt-in (the toggle already exists in
   SettingsScreen but is `disabled`); enable it. Per-channel opt-out
   if "Per-channel settings" is enabled.
3. **User-selected prewarn time for live events** — roller
   spinner (reuse the DND `TimeSpinner` pattern). Options: 15m, 30m,
   **1h (default)**, 2h, 4h, 1d. Per-channel override if per-channel
   settings are enabled.
4. **Custom confirm dialog** — replaces the native `Alert.alert` in
   the channel-removal flow (and any other destructive actions). Must
   match the app's dark-theme design (system `Alert.alert` is the
   default Android light dialog, which clashes).

## Icon styling

Likes/dislikes icons: **greyscale and minimalist**. Not filled-in blue
thumbs (that's the YouTube brand look). Think outline thumbs in a soft
grey (`#6b6b85` or similar — match the app's `textDim` color from
`COLORS`). Counts in the same color, slightly smaller than the views
count. No animation, no tap target — purely visual.

## Design decisions (from clarifying questions)

- **Default prewarn**: 1h
- **Post placeholder (no thumbnail)**: large speech-bubble shape that
  fills the 16:9 aspect of a normal video thumbnail. Inside the
  bubble: a small greyscale shrunk version of the channel's avatar.
  Attempt this first; fall back to a simpler icon-only placeholder
  if it's hard to implement cleanly.
- **Empty state for posts**: empty list is fine, no loading spinner
- **Default for likes/dislikes when not yet polled**: show thumb icons
  with the count as `0` (matches the existing "always render" pattern
  for views)

## Implementation order (4 commits, low-risk first)

### Commit 1 — Likes/dislikes in the meta row

- **Server**: parse `media:community` block in the YouTube RSS feed;
  capture `media:starRating@count` (likes) and `media:starRating@dislikes`
  on each video. Store alongside `views` in the `recent` array and
  per-video state.
- **Server**: same throttle as views: latest video only, hourly, 5%
  threshold. So if a video's like count changed by less than 5% since
  the last poll, don't write it.
- **Server**: include `likes` and `dislikes` in the `/feed` response.
- **App**: render two greyscale thumbs + counts in the meta row,
  between age and views.
- **App**: default to `0` if not yet polled.

**Files touched**:
- `worker/tubepulse-cron/index.js` (parse media:starRating, throttle
  writes, add to recent)
- `worker/tubepulse-api/index.js` (pass through to /feed)
- `src/screens/HomeScreen.js` (render likes/dislikes in the meta row)

**Cost**: zero new Data API calls. RSS is free. Throttled writes
keep the per-tick cost identical to the current view-count throttle.

### Commit 2 — Custom ConfirmDialog + replace Alert.alert

- **New component**: `src/components/ConfirmDialog.js` — reusable
  modal with dark backdrop, centered card using `COLORS.surface`,
  title, message, two buttons (Cancel subtle, Confirm in
  `COLORS.danger` for destructive actions).
- **Refactor**: replace `Alert.alert` in `ChannelsScreen.removeChannel`
  with the new `ConfirmDialog`. Same handler logic, just different
  UI.
- **Audit**: grep for other `Alert.alert` calls in the app; convert
  any destructive ones to the new dialog.

**Files touched**:
- New: `src/components/ConfirmDialog.js`
- Modified: `src/screens/ChannelsScreen.js` (and any others found)

**Cost**: pure UI change, no server work, no new dependencies.

### Commit 3 — Community posts

- **Server**: new cron job `runCommunityPostsCron`, triggered on
  `mins % 60 === 0` (shares the existing 5-min cron schedule, runs
  hourly).
- **Server**: new key `channel:{id}:recent:posts` parallel to
  `channel:{id}:recent`. Stores last ~20 posts.
- **Server**: per-channel "first-run" guard — first poll populates
  posts but doesn't notify (treats existing posts as already-seen).
- **Server**: `/feed` includes `posts: []` for each channel. Empty
  when posts are disabled, the channel has no posts, or it's the
  user's first poll.
- **Server**: push notification format: title `@channel posted`,
  body = first 100 chars of post text. Data: `{ type: 'post', ... }`.
- **App**: enable the `includeCommunityPosts` toggle in
  SettingsScreen (currently `disabled` with "Coming soon" subtitle).
  Change the subtitle to a brief positive explanation.
- **App**: new post card component in `HomeScreen`. Reuses the
  existing video card container. Differences: header text, thumbnail
  vs. placeholder rendering, body text (truncated to 3 lines).
- **App**: per-channel override support already works (existing
  `setChannelOverride` endpoint accepts arbitrary fields). Document
  the `includeCommunityPosts` field.

**Files touched**:
- `worker/tubepulse-cron/index.js` (new function, scheduled at
  `mins % 60 === 0`)
- `worker/tubepulse-api/index.js` (extend `/feed` to include posts)
- `src/screens/SettingsScreen.js` (enable the toggle)
- `src/screens/HomeScreen.js` (render post cards, with the
  speech-bubble placeholder)

**Cost**: 4 channels × 1 call/hour × 24 hours = 96 calls/day = 96
quota units/day. Plus retry overhead, ~100 units/day. **1% of the
10k free tier.** Acceptable.

### Commit 4 — Prewarn time for live events

- **Server**: extend `runUpcomingCron` to fire prewarn notifications.
  For each upcoming event, check if `now + prewarn_minutes ===
  starts_at` (within 5-min slack). If yes, send a prewarn push and
  mark it as sent.
- **Server**: new key `upcoming:prewarn:{eventId}:{window}` to track
  which prewarns have been sent (so we don't double-send). Cleaned
  when the event is over.
- **Server**: per-channel override: add `prewarnMinutes` to the
  channel override object. If per-channel notifications are enabled
  AND the override has a value, use that instead of the global.
- **App**: global prewarn setting in `SettingsScreen` near the DND
  toggle. Roller spinner with the 6 options.
- **App**: per-channel prewarn in the per-channel override card (if
  enabled), as a roller spinner next to the DND one.
- **App**: new `PrewarnSpinner` component (or just inline the
  options in `TimeSpinner`).

**Files touched**:
- `worker/tubepulse-cron/index.js` (extend `runUpcomingCron`)
- `src/screens/SettingsScreen.js` (global prewarn spinner)
- `src/screens/ChannelsScreen.js` or wherever per-channel overrides
  live (per-channel prewarn spinner)

**Cost**: zero new API calls. The prewarn logic reuses the existing
upcoming-events iteration (already running every 5 min).

## Build and release

After all four commits:
- `./build-and-release.sh 3.1.0 master`
- Update release notes on GitHub
- Tag v3.1.0
- Send Matt an email with the new APK

## Risks and unknowns

- **RSS field stability**: `media:community` (which contains likes +
  dislikes) has been stable in YouTube's RSS feeds for years. Some
  videos (very new, unlisted, region-locked) may have a missing
  block — handle gracefully (default to 0).
- **Dislike count accuracy**: YouTube removed public dislike counts
  in Nov 2021. The RSS feed still carries the field, but it's been
  zeroed out for years. We still capture it; it'll be `0` for most
  videos, which is the expected behavior.
- **Post polling order**: process channels sequentially with
  per-channel error handling. A slow or failing channel doesn't block
  the others. Matches the existing RSS poll pattern.
- **Post first-run guard**: on first poll, populate the recent list
  but don't fire a notification. Implemented by storing a
  `firstPollAt` timestamp per channel.
- **Post thumbnail fallback for icons**: if `post.kind` is `text` (no
  attachments), the placeholder is the only visual. Make sure the
  placeholder looks intentional, not lazy.

## Open questions

(none currently)

## Status

- [ ] Commit 1: Likes/dislikes in the meta row
- [ ] Commit 2: Custom ConfirmDialog + replace Alert.alert
- [ ] Commit 3: Community posts
- [ ] Commit 4: Prewarn time
- [ ] Build and release v3.1.0
