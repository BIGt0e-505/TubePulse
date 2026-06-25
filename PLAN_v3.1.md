# v3.1 Plan - Historical Record

This file is a historical planning record for the v3.1 release. It is no longer the canonical current-state document; use [STATUS.md](STATUS.md) for current repo status.

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

Design clarification (after build): **every new video gets a
notified-push when it appears**, including livestreams. The prewarn
is an *additional* advance notification fired at the user's chosen
offset (default 1h) before the scheduled time. At the moment the
livestream goes live, the regular RSS-poll path fires a normal
new-video push — there is no separate "is live now!" notification.
The prewarn is the heads-up; the regular push is the "this just
appeared" notification.

Behaviour matrix:
- Detect 6h before, 1h prewarn: prewarn fires 1h before live (cron
  resolution may make it 1h-5min to 1h+0min). Regular push fires at
  live time. **Two pushes.**
- Detect 30min before, 1h prewarn: prewarn time is 30min in the past.
  Fire immediately (better late than never) — prewarn body says
  "starting in 30 minutes". Regular push fires at live time.
  **Two pushes, prewarn is "late".**
- Detect 30min before, 30min prewarn: prewarn time is now. The
  prewarn window and the live time are too close together; we skip
  the prewarn entirely (don't fire a "starting in 0 minutes" push).
  Regular push at live time. **One push.**
- Detect at live time, any prewarn: the video is now `type: 'live'`
  and never enters `upcoming:events:list`. No prewarn is fired; the
  regular RSS-poll push is the notification. **One push.**

Implementation:
- **Server (cron)**: new `runPrewarnCron` function (separate from
  `runUpcomingCron` because the per-user prewarn is per-device and
  doesn't fit the bucket scheme). Iterates `upcoming:events:list`,
  for each (event, subscriber) pair computes the per-device prewarn
  time (per-channel override → global setting → default 60min), and
  fires a "going live soon" push if `prewarnTime <= now`. Tracks
  sent state in `upcoming:prewarn:{videoId}:{deviceId}`. Prunes
  events past `scheduledFor + 24h` and cleans up their sent keys.
  Wired into the 5-min cron tick.
- **Server (cron)**: `runUpcomingCron` is repurposed as a **drain**
  — it reads the current 5-min `upcoming:` bucket and deletes it
  without firing anything. Stale pre-v3.1 bucket entries are cleared
  this way on the first tick after upgrade, so the old "going live
  in 30 minutes" / "is live now!" pushes cannot fire for events
  scheduled before the upgrade.
- **Server (cron & API)**: when a `live_scheduled` video is detected
  by the RSS poll (cron) or WebSub push (API), it is appended to
  `upcoming:events:list` (idempotent — checks videoId presence).
  Bucket writes for `headsUp: true` and `headsUp: false` are
  removed.
- **Server (cron)**: at live time, the existing RSS poll re-detects
  the video as `type: 'live'`, adds it to `channelRecent`, marks
  it as `unwatched`, and fires a normal new-video push (the
  "uploaded" payload). For `live` videos, `isLivestream = true` so
  DND is bypassed — the live push always fires.
- **App**: new global setting `prewarnMinutes` in SettingsScreen
  (default 60) with the 6 options (15m, 30m, 1h, 2h, 4h, 1d).
- **App**: per-channel override `prewarnMinutes` in the
  ChannelsScreen modal — "Override global prewarn" switch + 6-option
  picker, tri-state (`null` = inherit, number = override). Save
  logic strips `null` from the override payload (same pattern as
  community posts).
- **App**: prewarn push taps (data.type === 'prewarn') open the
  YouTube watch URL for the scheduled video. The video is NOT
  marked as seen on tap — the prewarn is just a reminder, the
  "live now" regular push will still fire later.

**Files touched**:
- `worker/tubepulse-cron/index.js` (new `runPrewarnCron`,
  `runUpcomingCron` repurposed as drain, `live_scheduled` block
  simplified, key map extended)
- `worker/tubepulse-api/index.js` (bucket writes removed, events
  list append added, key map extended)
- `src/utils/constants.js` (`prewarnMinutes` in DEFAULT_SETTINGS,
  `PREWARN_OPTIONS` export)
- `src/screens/SettingsScreen.js` (global prewarn picker)
- `src/screens/ChannelsScreen.js` (per-channel prewarn override)
- `App.js` (prewarn push tap handler)

**Cost**: zero new API calls. The prewarn logic reuses the existing
5-min cron tick and the WebSub/RSS-poll path that already populates
`upcoming:events:list` (the same list the posts cron reads).

## Build and release

- ~~`./build-and-release.ps1 3.1.0 master`~~ — **DONE**: shipped as v3.1.0 (2026-06-03 18:51 UTC), then a series of patch releases v3.1.1 → v3.1.6 (then-current on 2026-06-04 09:41 UTC; no longer current repo version)
- ~~Update release notes on GitHub~~ — auto-generated by `--generate-notes`, then hand-edited to highlight likes/dislikes, posts, prewarn, and the ConfirmDialog
- ~~Tag v3.1.0~~ — tagged; current tag at the time was v3.1.6; see STATUS.md for current repo version evidence
- ~~Send Matt an email with the new APK~~ — **deferred**: Matt is out of the loop on this development arc per Aaron's standing instruction

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

- [x] Commit 1: Likes/dislikes in the meta row — **DONE** (commit `216ae0d`,
  pushed, both workers deployed, verified via wrangler tail)
  - Server: parseLikesDislikes, updateRecentLikesDislikes, /feed passes
    through
  - App: meta row shows age · likes · dislikes · views
  - Icon style: greyscale via U+FE0E text-presentation + COLORS.textDim
  - Note: plan text references `1b54f3c` (old hash from an earlier
    branch); actual shipped commit is `216ae0d` on `master`.
- [x] Commit 2: Custom ConfirmDialog + replace Alert.alert — **DONE**
  (commit `5043c69`, on `master`, unbuilt at time of writing)
  - New `src/components/ConfirmDialog.js`
  - Replaces `Alert.alert` in `ChannelsScreen.removeChannel`
- [x] Commit 3: Community posts — **DONE** (commit `3630a80`,
  on `master`, server unbuilt and unbuilt-and-undeployed at time of
  writing; server changes need to be deployed and the app needs to
  be built + installed before end-to-end testing)
  - **Server**: `runCommunityPostsCron` wired into the hourly tick,
      adds `post:{activityId}` entries to each subscriber's
      deviceState.unwatched list (so posts are first-class for
      new/seen, sharing the array with videos), respects the global
      `includeCommunityPosts` setting in addition to the per-channel
      override. `/feed` returns `posts: [...]` per channel with each
      post carrying an `unwatched` flag. Post IDs go through `/seen`
      the same way video IDs do (string match, namespaced).
  - **App**: SettingsScreen toggle enabled. HomeScreen renders post
      rows with thumbnail or speech-bubble placeholder, "Posts"
      mini-header, blue dot driven by `post.unwatched`. Channel
      "isNew" considers both videos and posts. Per-channel modal
      gets a tri-state picker (Global / On / Off). App.js handles
      post-push taps by marking the post seen and opening the
      YouTube community tab.
- [x] Commit 4: Prewarn time for live events — **DONE** (commit
  pending, on `master`, unbuilt; see §"Commit 4 — Prewarn time for
  live events" above for the corrected design)
  - **Server**: new `runPrewarnCron` fires per-device prewarn pushes
      at the user's chosen offset (default 1h, options 15m–1d).
      Driven by `upcoming:events:list`, sent state tracked in
      `upcoming:prewarn:{videoId}:{deviceId}`. Events pruned 24h
      after live time. `runUpcomingCron` repurposed as a drain
      (clears stale pre-v3.1 bucket entries without firing). The
      old hardcoded 30-min "going live in 30 minutes" / "is live
      now!" pushes are gone — prewarn is the heads-up, the regular
      new-video push at live time is the "this just appeared"
      notification (DND bypassed for `type: 'live'`).
  - **App**: global prewarn picker in SettingsScreen (6 options).
      Per-channel override in ChannelsScreen modal (Override
      switch + 6-option picker; null = inherit, number = override).
      Pre-warning push taps open the YouTube watch URL without
      marking the video as seen.
- [ ] Build and release v3.1.0

### Commit 3 follow-ups (post-deploy)

- [ ] Deploy the cron and API worker changes to Cloudflare.
- [ ] Build v3.1.0-rc APK and test on a real device:
      - Add a channel, wait for the hourly posts cron to fire,
        verify a push arrives.
      - Open the app, verify the post shows in the feed with a blue
        dot.
      - Tap the post, verify it opens the YouTube community tab and
        the blue dot clears.
      - Set the global `includeCommunityPosts` toggle off, verify
        posts disappear from the feed.
      - Set the per-channel "Off" override, verify posts are hidden
        for that channel only.
- [ ] **Known limitation**: posts do not enter the nag cycle — only
      the initial push fires, no 4-hour reminders. Plan did not
      require it; adding it would need a parallel nag bucket and FCM
      payload differentiation. Flagged for v3.2.
