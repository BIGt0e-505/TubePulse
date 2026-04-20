# TubePulse — Architecture Specification

**Version:** v3.0 (target)
**Date:** 2026-04-19
**Status:** Design — pre-implementation

---

## 1. Purpose of this document

This document is the source of truth for TubePulse's backend architecture. It exists to:

- Specify an architecture that scales from a handful of users to many thousands without rework
- Eliminate the Cloudflare Workers KV list-operation bottleneck that took down the previous version
- Give Jimothy a concrete spec to implement against, rather than vibes

If a future change to TubePulse contradicts something in this doc, either the change is wrong or the doc needs updating first. Don't silently drift.

---

## 2. Problem framing

### 2.1 What TubePulse does

TubePulse is an Android app that notifies users when YouTube channels they care about post new content. Users add channels, the app pushes notifications when those channels publish videos or go live, and a configurable nag cycle nudges users about videos they haven't watched yet.

### 2.2 The load shape

Two fundamentally different things happen at different rates:

- **YouTube publishes a video on a tracked channel.** Sparse and unpredictable. A typical channel publishes 0–3 times per week. Across all subscribed channels in TubePulse, this fires whenever any of them publishes — bursty but low absolute volume.
- **Users care about being reminded of unwatched videos.** Continuous and predictable. Cron-driven, runs whether or not anything new happened.

The previous architecture conflated these — the cron iterated all devices on every cycle, regardless of whether anything was new. This is what burned through KV list operations.

### 2.3 Scale targets

The architecture must handle, without rework:

- 100 active devices
- 100 channels per device maximum
- Total subscriptions in the low thousands
- Daily KV operations within Cloudflare free tier under normal load
- Headroom for peak loads (e.g. a major channel doing a coordinated drop watched by many users)

Beyond this scale, paid tier ($5/mo) is acceptable. The architecture should not require redesign at any point — only additional capacity.

### 2.4 Non-goals

- iOS support (different push infrastructure)
- Multi-region failover (Cloudflare handles this)
- Real-time chat or comments
- Polling YouTube Data API for new videos (doesn't scale, costs quota)
- Detecting deleted videos (don't care about stale entries)

---

## 3. Core architectural principle: channel-first

**Channels are the unit of work. Devices are the unit of subscription.**

Every operation should ask "what's happening to this channel" first, then "who cares about this channel". The reverse direction — "what does this device care about" — is only used at subscription change time and when serving a feed request.

This inversion is the single most important decision in this document. The previous architecture was device-first: iterate devices, look up their channels, check for news. It scales as O(devices × channels). The channel-first architecture scales as O(channels with new content × subscribers per channel), which is dramatically smaller because most channels have nothing new on most days.

### 3.1 Why this matters mathematically

For 100 devices averaging 20 channels each with 50% overlap, you have ~1,000 unique channels and ~2,000 subscriptions. Assuming 0.5 publishes/channel/day across the catalogue, that's ~500 publish events/day.

Device-first cron, every 5 minutes:
- 100 devices × 20 channels checked = 2,000 ops per cycle
- 288 cycles/day = 576,000 ops/day
- Plus list operations to enumerate devices: 288/day, each potentially returning all 100 device keys
- Free tier dies inside the day.

Channel-first event-driven:
- 500 publishes/day × ~2 subscribers per publish × ~3 ops per push = 3,000 ops/day
- Free tier handles it comfortably with 30x headroom.

The architectural difference is roughly 100x at this scale, and it widens as you grow.

---

## 4. Component overview

```
┌─────────────────┐    WebSub push    ┌──────────────────────┐
│  YouTube RSS    │ ────────────────→ │   tubepulse-api      │
│  Hub (PubSub)   │                   │   (Cloudflare Worker)│
└─────────────────┘                   │                      │
                                      │   /websub  ← push    │
┌─────────────────┐  REST + FCM push  │   /register          │
│  Android App    │ ←──────────────── │   /subscribe-channel │
│  (RN/Expo)      │                   │   /unsubscribe       │
└─────────────────┘                   │   /seen              │
        ▲                             │   /feed              │
        │ FCM                         │   /resolve           │
        │                             │   /bootstrap         │
┌───────┴─────────┐                   │   /settings          │
│   Firebase      │                   │   /channel-override  │
│   Cloud         │ ←── FCM send ──── └──────────┬───────────┘
│   Messaging     │                              │
└─────────────────┘                   ┌──────────▼───────────┐
                                      │   tubepulse-cron     │
                                      │   (Cloudflare Worker)│
                                      │                      │
                                      │   */5  upcoming events│
                                      │   */15 nag bucket    │
                                      │   0 */6 lease renewal│
                                      └──────────┬───────────┘
                                                 │
                                      ┌──────────▼───────────┐
                                      │   Cloudflare KV      │
                                      │   (single namespace) │
                                      └──────────────────────┘
```

### 4.1 Components

| Component | Role | Triggered by |
|-----------|------|--------------|
| `tubepulse-api` | REST API for app + WebSub callback | HTTP requests |
| `tubepulse-cron` | Three scheduled jobs (see §6) | Cron schedules |
| Cloudflare KV | Single namespace, all persistent state | Workers |
| Firebase Cloud Messaging | Push notifications to devices | API + cron workers |
| Android app | UI, device-local cache, FCM receiver | User + push |

### 4.2 What is NOT a component

- No database (KV only — see §5.1 for why)
- No queue (KV operations are fast enough)
- No separate cache layer (KV is already edge-cached)
- No backend service polling YouTube (WebSub does it)

---

## 5. Storage layer (Cloudflare KV)

### 5.1 Why KV and not D1

D1 (Cloudflare's SQLite) would let us write JOINs to express the channel↔device relationship naturally. We're not using it because:

- KV reads are edge-cached and faster
- The "denormalised inverse views" pattern (§5.3) makes JOINs unnecessary
- D1 has its own free-tier limits and adds another moving part
- The access pattern is overwhelmingly key-by-known-ID, which is exactly KV's strength

### 5.2 Single namespace

All keys live in one KV namespace. Prefix conventions distinguish entity types.

### 5.3 Key schema

All keys use `:` as separator, lowercase, with stable identifier components.

#### 5.3.1 Channel keys

```
channel:{channelId}:meta
  → JSON { name, avatarUrl, lastVideoId, addedAt }
  Read on:  every WebSub push (to compose notifications)
  Written:  on bootstrap, on metadata refresh

channel:{channelId}:subscribers
  → JSON [deviceId, deviceId, ...]
  Read on:  every WebSub push (to find who to notify)
  Written:  on subscribe / unsubscribe

channel:{channelId}:websub
  → JSON { leaseExpiresAt, hmacSecret, lastVerified }
  Read on:  WebSub callback verification, lease renewal cron
  Written:  on subscribe (first), on lease renewal

channel:{channelId}:recent
  → JSON [ { videoId, title, publishedAt, type, ... }, ... ]  (last 15)
  Read on:  /feed, /bootstrap, "live now" detection
  Written:  on every WebSub push for this channel
```

`type` is one of `video`, `live`, `live_scheduled`, `premiere`. See §7.2 for derivation rules.

#### 5.3.2 Device keys

```
device:{deviceId}:profile
  → JSON { fcmToken, createdAt, lastSeenAt, appVersion, platform }
  Read on:  every notification send to this device
  Written:  on /register, on token rotation

device:{deviceId}:settings
  → JSON { mode, nagInterval, dndStart, dndEnd, tapAction, ... }
  Read on:  every notification send (to filter by DND, decide nag mode)
  Written:  on settings change

device:{deviceId}:channels
  → JSON [channelId, channelId, ...]
  Read on:  /feed, /bootstrap
  Written:  on subscribe / unsubscribe

device:{deviceId}:override:{channelId}
  → JSON { mode?, nagInterval?, dndBypass?, muted? }
  Read on:  every notification send for this (device, channel) pair
  Written:  on per-channel settings change
  Note: only created when an override exists for this channel.
        Notification dispatch reads with a fallback to defaults.

device:{deviceId}:state:{channelId}
  → JSON { unwatched: [videoIds], lastNagAt, nagCount }
  Read on:  WebSub push for this channel + this device
  Written:  on push, on /seen
  Note: keyed per (device, channel) to keep individual reads small and
        avoid hot-key contention on a single device:state blob
```

#### 5.3.3 Time-bucket keys

```
upcoming:{YYYY-MM-DDTHH:MM}
  → JSON [ { channelId, videoId, type, scheduledFor }, ... ]
  Read on:  every 5-min cron tick
  Written:  on WebSub push containing a future-dated video

nag:{YYYY-MM-DDTHH:MM}
  → JSON [ { deviceId, channelId, videoIds }, ... ]
  Read on:  every 15-min cron tick
  Written:  on WebSub push (for chill mode 4-hour nudges)
            on /seen (to remove already-seen entries)
            on settings change to relentless (to add re-nag entries)
```

Buckets are aligned to wall-clock minutes (5-min for upcoming, 15-min for nag) so the cron always reads "the bucket for now" without ambiguity.

#### 5.3.4 Index keys

```
channels:active
  → JSON [channelId, channelId, ...]
  Read on:  WebSub lease renewal cron (to know what to renew)
  Written:  on first subscriber added to a channel
            on last subscriber removed from a channel
  Note: This is the ONLY list-style index. We maintain it manually
        rather than using KV.list() so list operations stay at zero.
```

### 5.4 Why no `KV.list()` anywhere

Every place the previous version called `KV.list()`, this architecture either:

1. Has the data already (channel-first means we know which channel triggered the work)
2. Reads a maintained index key (`channels:active` for lease renewal)
3. Uses a time-bucketed key the cron reads directly

`KV.list()` calls in the codebase should be treated as a bug.

### 5.5 Read/write costs per operation

| Operation | Reads | Writes |
|-----------|-------|--------|
| WebSub push (per subscriber on the channel) | 4 | 2 |
| /register (new device) | 1 | 1 |
| /subscribe-channel | 2 | 4 |
| /unsubscribe | 2 | 3 |
| /seen single video | 1 | 1 |
| /seen clear all for channel | 1 | 1 |
| /feed | 1 + N (where N = subscribed channels) | 0 |
| /bootstrap (per new channel) | 1 | 4 |
| /channel-override (set or update) | 0 | 1 |
| /settings | 0 | 1 |
| Upcoming cron tick (no events) | 1 | 0 |
| Upcoming cron tick (per event firing) | 2 | 2 |
| Nag cron tick (no nags due) | 1 | 0 |
| Nag cron tick (per nag firing) | 4 | 2 |
| Lease renewal cron tick | 1 + N (where N = channels needing renewal) | N |

The "4 reads per subscriber" on WebSub push is: profile + settings + override (if exists) + per-channel state.

These numbers should be verified against the actual implementation. Add KV op counters and log totals daily.

### 5.6 Channel cap

100 channels per device, enforced in the API layer at /subscribe-channel. Reject with 400 if the device's channel count is already at 100.

This is a soft cap — if the requirement changes, raising it requires no schema change, only an API constant.

---

## 6. Cron jobs

Three separate scheduled workers, each with a single responsibility. Splitting them lets each run at its natural frequency without the others becoming a bottleneck.

### 6.1 Upcoming events cron — every 5 minutes

```
*/5 * * * *
```

Reads the `upcoming:` bucket key for the current 5-minute window. For each entry:
- If `type == live_scheduled` and `scheduledFor` is exactly 30 minutes away, fire "live soon" notification
- If `type == live_scheduled` and `scheduledFor` has passed, fire "live now" notification and reschedule into the nag system

Cost per tick: 1 read minimum, 2 reads + 2 writes per event firing. Most ticks have nothing in the bucket.

### 6.2 Nag cron — every 15 minutes

```
*/15 * * * *
```

Reads the `nag:` bucket key for the current 15-minute window. For each entry:
- Read device profile + settings + per-channel override
- Filter by DND, mode, etc. (override beats settings beats default)
- Send FCM notification
- Compute next nag time and schedule into the next bucket (chill: +4h; relentless: +nagInterval)

Cost per tick: 1 read minimum, 4 reads + 2 writes per nag firing.

15 minutes is fine for nags because nag frequency is configured in 5-min minimum increments — worst case a "5-minute" nag fires up to 15 minutes late. Document this in user-facing settings as "approximately every 5 minutes".

### 6.3 Lease renewal cron — every 6 hours

```
0 */6 * * *
```

Reads `channels:active`. For each channel:
- Read `channel:{channelId}:websub`
- If lease expires within 24 hours, renew via WebSub PubSubHubbub

Cost per tick: 1 + N reads, M writes (where M = channels needing renewal in this window).

6-hour cadence with 24-hour-ahead renewal gives 4x safety margin against worker outages.

### 6.4 What's NOT in any cron

- "Check channels for new videos" — WebSub push handles this
- "Iterate devices to find unwatched videos" — devices already have local state; nags are pre-scheduled
- "Refresh channel metadata" — done lazily on next push or bootstrap

---

## 7. WebSub push handling

### 7.1 Verification (GET /websub)

Standard WebSub challenge-response. Read `channel:{channelId}:websub` to verify the request matches a subscription we initiated. Return the challenge token if valid, 404 otherwise.

### 7.2 Push delivery (POST /websub)

The hot path. This is what fires when YouTube tells us a channel has new content.

```
1. Verify HMAC signature against channel:{channelId}:websub.hmacSecret
2. Parse the Atom feed payload — extract videoId, title, publishedAt
3. Determine type:
   - publishedAt > now() + 5min  → live_scheduled (it's a future-dated entry)
   - title starts with "🔴" or contains "LIVE"  → live (heuristic, refine over time)
   - default                                    → video
4. Read channel:{channelId}:recent
5. If videoId is already in recent → ignore (WebSub can deliver duplicates)
6. Prepend new entry; trim to 15 most recent; write back
7. Read channel:{channelId}:subscribers
8. For each deviceId in subscribers:
   a. Read device:{deviceId}:profile + device:{deviceId}:settings
   b. Read device:{deviceId}:override:{channelId} (may be null — that's fine)
   c. Resolve effective settings: override fields beat base settings
   d. If muted via override → skip entirely
   e. If DND active and dndBypass not set and not a livestream
      → skip immediate notification; schedule a batched nag for end of DND
   f. Send FCM with appropriate payload
   g. Update device:{deviceId}:state:{channelId} with new unwatched videoId
   h. Schedule next nag in nag bucket (4h ahead for chill, nagInterval ahead for relentless)
9. If type == live_scheduled:
   - Write entry into upcoming:{publishedAt - 30min} bucket (heads-up)
   - Write entry into upcoming:{publishedAt} bucket (live-now)
```

### 7.3 Why WebSub is a hard requirement

WebSub is the only way to get push-style notifications from YouTube without polling. Polling either uses YouTube Data API quota (limited) or RSS feeds (works but expensive at scale). WebSub is push, free, and standard.

If WebSub becomes unreliable in the future, the fallback design is to poll RSS at the cron level — but architect such that the rest of the system doesn't notice. RSS polling would call the same "process new video for channel" function the WebSub handler does.

---

## 8. API endpoints

All endpoints accept `deviceId` as authentication (device-generated UUID, registered on first launch). No JWT, no OAuth. The deviceId is the secret.

### 8.1 POST /register

Initial device registration or FCM token refresh.

Request: `{ deviceId, fcmToken, platform, appVersion }`
Response: `{ ok: true }`

Writes `device:{deviceId}:profile`. Idempotent — safe to call on every app launch.

### 8.2 POST /subscribe-channel

Add a channel to this device's subscription list.

Request: `{ deviceId, channelId }`
Response: `{ ok: true, alreadySubscribed: false, channel: { ... } }`

Logic:
1. Read `device:{deviceId}:channels`
2. If already at 100 channels, reject with 400
3. Add channelId; write back
4. Read `channel:{channelId}:subscribers`; add deviceId; write back
5. If `channel:{channelId}:meta` doesn't exist, run bootstrap (fetch RSS, write meta + recent)
6. If we just became the first subscriber, add to `channels:active` index and initiate WebSub subscription

### 8.3 POST /unsubscribe

Remove channel from this device. Logic mirrors subscribe in reverse. If we're removing the last subscriber, cancel WebSub subscription and remove from `channels:active`.

### 8.4 POST /seen

Mark videos as seen.

Request: `{ deviceId, channelId, videoIds?, clearAll? }`

Logic:
1. Read `device:{deviceId}:state:{channelId}`
2. Remove specified videoIds (or all if `clearAll: true`)
3. Write back
4. Pending nag bucket entries are not actively cleaned up — instead, when the nag cron tries to fire, it re-checks state and skips videos that are no longer unwatched

### 8.5 GET /feed

Get current feed for this device. Used for initial app load and pull-to-refresh.

Response: `{ channels: [{ channelId, meta, recent, unwatchedCount }, ...] }`

Reads `device:{deviceId}:channels`, then for each channel reads `meta`, `recent`, and `state` (per-device unwatched). N+1 reads but bounded by the 100-channel cap.

### 8.6 GET /resolve

Resolve a YouTube handle (`@MrBeast`) or username to a channelId.

Uses YouTube Data API (`channels.list?forHandle=...` with `forUsername` fallback). Costs 1 quota unit per call. Cache results in a `handle:{lowercased}` key for 7 days to avoid re-resolving.

### 8.7 POST /bootstrap

Initial fetch of channel data. Fetches the RSS feed, writes meta + recent, then returns to the client.

Synchronous (caller waits for the result) so the app can show the channel immediately after add.

### 8.8 POST /settings

Update device-level notification settings.

Request: `{ deviceId, settings: { mode, nagInterval, dndStart, dndEnd, tapAction, ... } }`

Writes `device:{deviceId}:settings`. Full replacement, not partial update.

### 8.9 POST /channel-override

Set or update per-channel notification override.

Request: `{ deviceId, channelId, override: { mode?, nagInterval?, dndBypass?, muted? } }` — any field can be omitted to inherit from device-level settings. Empty `override: {}` deletes the override entirely.

Writes `device:{deviceId}:override:{channelId}` (or deletes it if the override is empty).

---

## 9. Android app responsibilities

### 9.1 What the app does

- Maintains local cache of subscribed channels and their recent videos in AsyncStorage
- Renders the channel list and video list from local cache
- Calls `/subscribe-channel` and `/unsubscribe` when user adds/removes channels
- Calls `/seen` when user taps a video or "mark all seen" on a channel
- Calls `/register` on first launch and on FCM token rotation
- Calls `/feed` on pull-to-refresh and initial app load (after register)
- Receives FCM pushes and updates local cache + UI

### 9.2 What the app does NOT do

- Poll the API for updates (FCM is the source of truth for new content)
- Cache things server-side (the device is the cache)
- Try to be smart about backend state (treat `/feed` response as authoritative)

### 9.3 Local-first vs server-first

The app should feel instant. That means:

- Reads come from AsyncStorage first, network second
- Writes update AsyncStorage immediately, then call the API in the background
- API failures are visible but don't block the UI
- Pull-to-refresh shows the API as the merge target (server data wins on conflict)

### 9.4 Notification handling

When an FCM push arrives:

1. Update `state:{channelId}` in AsyncStorage to reflect new unwatched video
2. Update the local channel cache to include the new video in recent
3. If app is in foreground, refresh the visible UI silently
4. The notification itself is shown by Android regardless of app state

---

## 10. Failure modes and recovery

### 10.1 WebSub subscription expires without renewal

Symptoms: stop receiving pushes for a channel.
Recovery: Lease renewal cron runs every 6 hours and renews anything within 24h of expiry. Worst case: 6h gap between detection of expiry and renewal.
Defense: 24h-ahead renewal window means we'd need 24h+ of cron downtime to actually miss anything.

### 10.2 KV write fails mid-operation

Symptoms: partial state — e.g. device is in `channel:subscribers` but channel isn't in `device:channels`.
Recovery: idempotent operations. Re-running subscribe is safe (it adds-if-not-present). Periodic consistency check job (weekly) reconciles by reading both sides of every relationship.
Defense: write the inverse-view keys in a consistent order so partial failure leaves a known partial state.

### 10.3 FCM send fails

Symptoms: notification never arrives.
Recovery: don't update nag state until FCM ack received. Next cron tick will retry (up to a max retry count).
Defense: log all FCM failures with the full payload to a `fcm_errors:{date}` key for diagnosis.

### 10.4 Device deleted from Play Store but FCM token still valid

Symptoms: pushes continue forever to a phantom user.
Recovery: FCM returns `NotRegistered` for uninstalled apps. On that error, delete `device:{deviceId}:*` keys and remove deviceId from all `channel:*:subscribers` arrays.
Defense: include cleanup-on-FCM-error as part of the standard send path.

### 10.5 KV throttling

Symptoms: 429 errors on writes when burst exceeds rate limits.
Recovery: API endpoints return 503 with Retry-After; app retries with exponential backoff. WebSub pushes don't retry from YouTube's side, but the next push for the same channel will catch us up.
Defense: alert at 80% of any KV limit and investigate before hitting the wall.

---

## 11. Observability

Cloudflare provides per-namespace KV operation counts in the dashboard, but only at daily granularity. For operational monitoring we need finer detail.

### 11.1 Metrics to capture

In a single `metrics:{YYYY-MM-DD}` key, append (or overwrite-with-merge):

```json
{
  "websub_pushes": 1234,
  "fcm_sends_success": 4567,
  "fcm_sends_failed": 12,
  "api_requests": { "register": 100, "subscribe-channel": 50, ... },
  "cron_runs": { "upcoming": 288, "nag": 96, "lease": 4 },
  "kv_ops": { "reads": 23456, "writes": 7890, "deletes": 12 }
}
```

Workers update this key in batches (e.g. flushed every 5 minutes from worker memory) to avoid one-write-per-event amplifying KV usage itself.

### 11.2 Alerts

- Cloudflare email alert at 80% of any KV limit (configured in dashboard)
- Daily summary: write the previous day's `metrics` key to a Telegram webhook
- WebSub subscription health: weekly job that verifies every `channels:active` entry has a non-expired lease

---

## 12. Implementation order

Suggested sequence to minimise risk. Each step should produce a working, testable deliverable. Don't build all the workers first and test at the end.

1. **Set up KV namespace and a smoke-test Worker.** Create a few keys in the new schema, verify reads work.
2. **Build the channel-first WebSub handler.** Highest-value piece — both the hot path and the architectural inversion that makes everything else work. Test with a single subscribed channel before moving on.
3. **Build the API endpoints.** Register, subscribe, unsubscribe, seen, feed, resolve, bootstrap, settings, channel-override. Each should be unit-testable.
4. **Build the nag bucket cron.** Verify nag entries flow from WebSub push → bucket → fired notification.
5. **Build the upcoming events cron.** Verify scheduled livestreams fire heads-up and live-now correctly.
6. **Build the lease renewal cron.** Last because it's the slowest-ticking job and easiest to verify works.
7. **Update the app to talk to the new API.** Local cache, FCM payload handling, all endpoint calls.
8. **Observability.** Metrics key updates, alerts, daily summary push to Telegram.

---

## 13. Things this document deliberately doesn't specify

- Code style or language choices within Workers
- Specific FCM payload structure (implementation detail)
- App UI layout or navigation (separate concern)
- YouTube Data API quota management (only used in /resolve, low volume)
- Logging format (be consistent, but use whatever)

These can vary with implementation and will appear in the codebase as they're built.

---

## Appendix A: Glossary

- **WebSub**: W3C standard for content distribution. YouTube exposes RSS feeds via the PubSubHubbub hub at `pubsubhubbub.appspot.com`. Subscribers receive HTTP POSTs when content updates.
- **HMAC**: Hash-based message authentication code. WebSub uses HMAC-SHA1 to verify push payload authenticity.
- **FCM**: Firebase Cloud Messaging. Google's push notification service for Android.
- **Cron trigger**: Cloudflare Workers feature that runs a Worker on a schedule (cron expression).
- **KV**: Cloudflare's edge key-value store. Eventually consistent, edge-cached, free-tier-limited.
- **Lease**: WebSub subscriptions expire after a finite period (we use 5 days). Must be renewed.
- **Nag**: TubePulse-specific term for repeated reminder notifications about unwatched videos.
- **DND**: Do Not Disturb. User-configured time windows where notifications are suppressed.
- **Override**: Per-channel customisation of notification behaviour, taking precedence over device-level settings.
