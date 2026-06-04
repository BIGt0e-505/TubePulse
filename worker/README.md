# TubePulse — Cloud Services

This document describes the TubePulse backend: the two Cloudflare Workers, the Cloudflare KV store, the YouTube Data API surface we use, and the Firebase Cloud Messaging integration. It is the source of truth for "how the cloud side actually works." The Android app is documented separately in the project root README.

---

## 1. High-level architecture

```
                                                ┌─────────────────────────────┐
                                                │     YouTube RSS feed        │
                                                │  (free, no auth, no quota)  │
                                                └──────────────┬──────────────┘
                                                               │ every 5 min
                                                               ▼
┌────────────┐     HTTPS     ┌────────────────────┐    fan-out    ┌────────────────────┐
│ Android    │──────────────▶│ tubepulse-api      │◀──────────────│ tubepulse-cron     │
│ app        │               │ (Cloudflare Worker)│               │ (Cloudflare Worker)│
│            │◀── FCM push ──│                    │── FCM v1 API ─▶│ YouTube Data API   │
└────────────┘               └────────┬───────────┘               │ (subscribe-time    │
                                     │                           │  only, 1-2 units)  │
                                     ▼                           └────────────────────┘
                            ┌─────────────────┐
                            │ Cloudflare KV   │
                            │ (single ns)     │
                            └─────────────────┘
                                       ▲
                                       │ same KV
                                       │
                            ┌──────────┴──────┐
                            │ tubepulse-cron  │
                            │ (also reads/writes same KV)
                            └─────────────────┘
```

**Two workers, one KV namespace, one Firebase project.**

| Component | URL | Purpose |
|-----------|-----|---------|
| `tubepulse-api` | n/a — no public route | HTTP API for the app + dormant WebSub callback (callable from cron via service binding or `wrangler dev` only) |
| `tubepulse-cron` | n/a — scheduled trigger only | Scheduled jobs (every 5 min): upcoming-events drain, prewarn, RSS poll, community posts, nag cycle, WebSub lease renewal |
| `TUBEPULSE_KV` | KV namespace `52e77ca9f5f6493e89d2478c8d3055ec` | All persistent state |

> **Note:** Both workers are deployed but have no public HTTP routes. `tubepulse-cron` is scheduled-trigger only; `tubepulse-api` has `routes = []` in `wrangler.toml`. The `*.workers.dev` URLs listed in older docs are no longer reachable. The API is callable from the cron worker via a service binding (when configured) or directly via `wrangler dev` / `wrangler tail`.

The two workers share the **same KV namespace** so they can read each other's writes. The cron writes `channel:{id}:recent` and `channel:{id}:meta`; the API reads them when serving `/feed`.

---

## 2. Why two workers, not one?

The cron worker is `scheduled`-trigger only — it has no `fetch()` handler. This is deliberate:

- **No public HTTP surface** — no attack surface, no auth concerns
- **Different scaling profile** — the cron is a CPU-bound fan-out over all subscribers, the API is request/response. They have different failure modes.
- **Independent deploy cadence** — the cron changes more often (new RSS parsing logic, throttling tweaks) than the API. Keeping them separate means less risk of breaking one while changing the other.

Both workers use the same KV namespace, so the cron can write state that the API reads directly.

---

## 3. The cron worker

`worker/tubepulse-cron/index.js` — deployed via `wrangler deploy` in `worker/tubepulse-cron/`. **1503 lines** as of v3.1.6.

**Schedule:** `*/5 * * * *` (every 5 minutes), configured in `wrangler.toml`.

The worker has **one** `scheduled()` handler that dispatches to six jobs based on the current minute:

| # | Job | Trigger | Function | What it does |
|---|-----|---------|----------|--------------|
| 1 | Upcoming-events drain | every 5 min | `runUpcomingCron` | Reads `upcoming:{bucket}` for the current 5-min window and deletes it. **Drain-only since v3.1** — clears any pre-v3.1 bucket entries so the old "going live in 30 minutes" / "is live now!" pushes cannot fire for events scheduled before the upgrade. No new pushes are written to buckets. |
| 2 | Prewarn (v3.1) | every 5 min | `runPrewarnCron` | Iterates `upcoming:events:list` and fires a per-device "going live soon" FCM push when each device's prewarn window opens. The prewarn offset is per-device: per-channel override → global setting → default 60 min. Sent state tracked in `upcoming:prewarn:{videoId}:{deviceId}` to prevent double-send. Events pruned 24 h after `scheduledFor`. |
| 3 | RSS poll | every 5 min | `runRssPollCron` | Reads `channels:active`, fetches the RSS feed for each channel, diffs against `channel:{id}:recent`. New videos → FCM fan-out. **Active new-video detection path** since the 2024 WebSub hub shutdown. |
| 4 | Community posts (v3.1) | every hour (`mins === 0`) | `runCommunityPostsCron` | Polls YouTube Data API `activities.list` for each channel in `channels:active`. Captures text, image, and poll community posts. First-run guard populates the recent list without firing notifications. Cost: ~1 unit/channel/hour. |
| 5 | Nag cycle | every 15 min | `runNagCron` | Reads `nag:{bucket}` for the current 15-min window. Re-notifies devices about unwatched videos per their nag settings. Posts do not enter the nag cycle. |
| 6 | Lease renewal | every 6 h | `runLeaseCron` | **Dormant no-op** — Google's PubSubHubbub hub was shut down in 2024. Code path remains for future revival. |

### 3.1 RSS poll — the active new-video detection path

Since WebSub hub shutdown, the cron detects new videos by polling YouTube's public RSS feed:

```
https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx
```

Each entry in the Atom feed carries: `videoId`, `title`, `publishedAt`, `thumbnail`, `link`, **view count** (from `media:community/media:statistics/@_views`), **like count** (from `media:starRating/@_count`), and **dislike count** (from `media:statistics/@_dislikes` — usually `0` for public videos since YouTube removed public dislike counts in Nov 2021; the field is still captured for completeness).

**Flow per channel per tick:**

1. Read `channels:active` (KV list)
2. For each channelId:
   - GET the RSS feed (with `User-Agent` + `SOCS` cookie to bypass the EU/UK consent wall)
   - Parse with a regex-based Atom parser (no XML library needed in the worker)
   - Read `channel:{id}:recent` from KV
   - Find videos in RSS that aren't in `recent` → new videos
   - For new videos: write updated `channel:{id}:recent` and `channel:{id}:meta`, then look up subscribers and fan out FCM pushes
3. Truncate `recent` to 15 entries

**Quota cost: 0 YouTube Data API units.** RSS is a free public feed. Cloudflare KV cost: ~1 read per channel per tick, with writes only when a new video is detected, when engagement metrics cross their threshold, or when the top-of-hour top-of-list view refresh runs (see §6.4 below).

### 3.2 FCM push from the cron

For each new video, the cron does the standard fan-out (which is identical to what a WebSub push would have done):

1. Read `channel:{id}:subscribers` to get the list of devices
2. For each device:
   - Read `device:{id}:profile` (FCM token), `device:{id}:settings`, and `device:{id}:override:{channelId}`
   - Skip if muted via override, or if DND is active and the override doesn't bypass it
   - Sign a JWT using the Firebase service account, exchange for an OAuth token, POST to `fcm.googleapis.com/v1/projects/{projectId}/messages:send`
3. Update `device:{id}:state:{channelId}` with the new `unwatched` list
4. Schedule the next nag into the appropriate `nag:{bucket}` entry

---

## 4. The API worker

`worker/tubepulse-api/index.js` — deployed via `wrangler deploy` in `worker/tubepulse-api/`. **1774 lines** as of v3.1.6 (matches `wc -l worker/tubepulse-api/index.js`).

**No public route, no schedule** — the worker is reachable only from within the Cloudflare account (via service binding from the cron, or via `wrangler dev` / `wrangler tail`). The single entry point is `fetch(request, env, ctx)`, which routes by `path` and `request.method`. The `routes = []` line in `tubepulse-api/wrangler.toml` disables the public HTTP route by design.

### 4.1 Endpoint map

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/` | none | Health check (inlined — returns `{ status: 'ok', version: '3.0.0', worker: 'tubepulse-api', architecture: 'channel-first' }`). The `version` field is a stale label; bump when changed. |
| `POST` | `/register` | Bearer | `handleRegister` — create/update device profile (FCM token optional). Two-phase deviceId migration for cross-version upgrades (see §11.1). |
| `POST` | `/subscribe-channel` | Bearer | `handleSubscribeChannel` — add a channel, fetch its avatar via Data API (first-subscribe only), RSS bootstrap (zero quota) |
| `POST` | `/unsubscribe` | Bearer | `handleUnsubscribe` — remove a channel, clean up subscriber list and active index, call `cleanupDeadChannel` if the device was the last subscriber |
| `POST` | `/seen` | Bearer | `handleSeen` — mark videos / posts as watched. `ids: [videoId, "post:activityId", ...]` for individual marks; `clearAll: true` for channel-tap (clears all videos and posts for that channel) |
| `GET`  | `/feed` | Bearer | `handleFeed` — return recent videos + community posts for all subscribed channels, with per-device `unwatched` flags merged in |
| `GET`  | `/resolve` | Bearer | `handleResolve` — `@handle` → channelId (Data API, cached 7 days in `handle:*`) |
| `POST` | `/bootstrap` | Bearer | `handleBootstrap` — on-demand channel meta + recent videos refresh (RSS primary, Data API fallback for the rare unreachable-RSS case) |
| `POST` | `/settings` | Bearer | `handleSettings` — update device notification settings. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1) |
| `POST` | `/channel-override` | Bearer | `handleChannelOverride` — set per-channel override. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1, tri-state null/value) |
| `GET`  | `/websub` | none | `handleWebSubVerification` — WebSub handshake (dormant) |
| `POST` | `/websub` | HMAC | `handleWebSubPush` — WebSub push delivery (dormant) |
| `OPTIONS` | * | none | CORS preflight — allow any path |

**Auth model:** Every authenticated endpoint requires `Authorization: Bearer <deviceId>`. The `deviceId` is a UUID generated on first launch (via `expo-secure-store` since v3.0.20; previously a random UUID, then `Application.getAndroidId()`). There is no login — the deviceId *is* the auth token. This is acceptable because the KV is private and the deviceId is unguessable (UUIDv4 / Android-ID / secure-store UUID).

### 4.2 Bootstrap-on-subscribe (the most important code path)

When a new device subscribes to a channel, the API worker does **the only work that uses the YouTube Data API at subscribe time**:

1. **Resolve channel via Data API** (`channels.list?part=snippet&forHandle=...` or `forUsername=...`) — 1 quota unit, returns channelId + name + avatar URL in one call. Only runs if `meta` is missing.
2. **Fetch recent videos via RSS** — 0 quota units, returns up to 15 videos with view counts, like counts, and dislike counts (from `media:community`, `media:starRating`, and `media:statistics`)
3. Cache the channel meta + recent list in KV
4. Add the channel to `channels:active` (if this device is the first subscriber)
5. Try a dormant WebSub subscription (no quota cost, just a POST that 404s — kept for future hub revival)

**The YouTube Data API is called at most once per new channel** (the avatar resolve, on the very first subscribe for that channel). After that, all writes to `channel:{id}:meta` and `channel:{id}:recent` come from the cron worker via RSS, which costs 0 quota units.

### 4.3 WebSub (dormant)

The WebSub handlers are intact but unused since 2024 (Google's hub was shut down). The code path remains in case a YouTube-compatible hub reappears or you want to integrate with a self-hosted hub.

---

## 5. KV schema (the only persistent state)

`worker/tubepulse-api/index.js` defines a `key` object that builds all KV keys. Both workers import this same object.

| Key | Type | Contents | Written by | Read by |
|-----|------|----------|------------|---------|
| `channel:{channelId}:meta` | JSON | `{ name, avatarUrl, lastVideoId, addedAt, viewsLastCheckedHour? }` | API (subscribe), Cron (new video + view refresh) | API (feed, bootstrap) |
| `channel:{channelId}:subscribers` | JSON array | `[deviceId, ...]` | API (subscribe, unsubscribe) | Cron (FCM fan-out), API (unsubscribe cleanup) |
| `channel:{channelId}:websub` | JSON | `{ leaseExpiresAt, hmacSecret, lastVerified }` | API (subscribe, dormant) | (none — never used) |
| `channel:{channelId}:recent` | JSON array | `[{ videoId, title, publishedAt, thumbnail, type, link, views, likes, dislikes, viewsLastCheckedHour? }]` — **v3.1**: `likes` + `dislikes` extracted from `media:starRating` and `media:statistics` | Cron (RSS poll) | API (feed, bootstrap), API (subscribe for first-time populate) |
| `channel:{channelId}:recent:posts` | JSON array | `[{ activityId, kind, text, thumbnail, link, publishedAt }, ...]` — last 30 community posts (**v3.1**) | Cron (community posts) | API (feed) |
| `channel:{channelId}:firstPollAt:posts` | string | ISO timestamp of the first posts-cron run for this channel — drives the first-run guard (**v3.1**) | Cron (community posts) | Cron (community posts) |
| `device:{deviceId}:profile` | JSON | `{ fcmToken, platform, appVersion, createdAt, lastSeenAt }` | API (register) | API (any auth call), Cron (FCM fan-out) |
| `device:{deviceId}:settings` | JSON | `{ mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, dndBypass, tapAction, includeCommunityPosts (v3.1), prewarnMinutes (v3.1), ... }` | API (settings) | Cron (FCM fan-out filter) |
| `device:{deviceId}:channels` | JSON array | `[channelId, ...]` | API (subscribe, unsubscribe) | API (feed filter) |
| `device:{deviceId}:override:{channelId}` | JSON | per-channel notification override. May include `mode?`, `nagInterval?`, `dndBypass?`, `muted?`, `includeCommunityPosts?` (**v3.1**, tri-state null/true/false), `prewarnMinutes?` (**v3.1**, tri-state null/number) | API (channel-override) | Cron (FCM fan-out filter) |
| `device:{deviceId}:state:{channelId}` | JSON | `{ unwatched: [...], lastNagAt, nagCount }` — `unwatched` holds plain videoIds and `post:{activityId}` for community posts (**v3.1** shares the array via `post:` namespace) | Cron (new video, nag fire) | Cron (nag fire, seen cleanup) |
| `upcoming:events:list` | JSON array | `[{ channelId, videoId, scheduledFor, addedAt }, ...]` — currently-scheduled live events, pruned 24h after live (**v3.1**, replaces the pre-v3.1 `upcoming:{bucket}` scheme) | Cron (RSS poll) | Cron (prewarn cron) |
| `upcoming:prewarn:{videoId}:{deviceId}` | number | `prewarnMinutes` value at send-time, sentinel for "prewarn sent for this (event, device)" (**v3.1**) | Cron (prewarn fire) | Cron (prewarn fire) |
| `upcoming:{bucket}` | JSON array | pre-v3.1 scheduled-livestream entries | (legacy writes only) | Cron (`runUpcomingCron` drain-only) |
| `nag:{bucket}` | JSON array | pending nag entries (15-min window) | Cron (nag fire, reschedule) | Cron (nag cron) |
| `channels:active` | JSON array | `[channelId, ...]` — index of channels with ≥1 subscriber | API (subscribe, unsubscribe) | Cron (RSS poll, community posts) |
| `handle:{lowercase}` | JSON | `{ channelId, cachedAt }` — 7-day TTL | API (resolve) | API (resolve) |
| `fcm:lookup:{fcmToken}` | string | `deviceId` — reverse index from FCM token to the device that owns it | API (register) | API (register, migration) |

**`channels:active` is the secret sauce.** It replaces a `KV.list()` call — the only way to know "which channels have at least one subscriber" without scanning the entire namespace. The cron reads this list, processes each channel, done. No `list()`.

**`fcm:lookup:*` is the deviceId-migration index.** When the same FCM token registers with a new `deviceId` (e.g. a v3.0.18 UUID-based install upgrades to v3.0.19's Android-ID-based install), the server uses this index to find the old device and migrate its state. See §11.1.

**Key lifecycle (cleanup):** channel and device keys are deleted by two helpers, `cleanupDeadChannel()` and `cleanupDeadDevice()` — see §11. Channel keys (`meta`/`recent`/`websub` + the `channels:active` membership) are deleted when the last subscriber leaves or is detected as dead. Device keys (`profile`/`settings`/`channels`/`state:*`/`override:*`) are deleted only when the FCM token is reported dead. The `fcm:lookup:*` key is deleted as part of the device cleanup.

---

## 6. Cost analysis (1 user, 4 channels)

### 6.1 YouTube Data API (free tier: 10,000 units/day)

| Operation | Quota units | When |
|-----------|-------------|------|
| `/resolve` (`channels.list?part=snippet&forHandle=...`) | 1 unit | Per unique handle, cached 7 days |
| `handle:*` cache hit | 0 units | Subsequent lookups for the same handle |
| Subscribe-time avatar fetch (in `/subscribe-channel`) | 1 unit | Per new channel added (one-time, cached forever in `channel:{id}:meta`) |
| Cron tick — RSS-based video detection | **0 units** | RSS feed has no API key requirement |
| Cron tick — community posts (`runCommunityPostsCron`, **v3.1**) | 1 unit / channel / hour | Per active channel, hourly |
| **Total steady-state (4 channels)** | **~96 units/day** | 4 channels × 1/hour × 24h = 96 units for posts. New-channel adds are one-time, ~2 units each. |

### 6.2 Cloudflare Workers (free tier: 100,000 requests/day, 10ms CPU per invocation)

| Worker | Invocations/day | CPU per | Notes |
|--------|-----------------|---------|-------|
| `tubepulse-cron` (scheduled) | 288 | ~3ms | Every 5 min, ~2.7s wall for 8 channels in the actual test |
| `tubepulse-api` (HTTP) | ~20-50 | ~5ms | Depends on app open frequency and action count |

### 6.3 Cloudflare KV (free tier: 100K reads, 1K writes, 1K list, 1GB storage)

**Reads per day (1 user, 4 channels):**
- Cron: 1 `channels:active` + 4 `channel:{id}:recent` + 1 `upcoming:{bucket}` + 1 `nag:{bucket}` per 5 min = 7 × 288 = **2,016 reads/day**
- API (per app open): 4 `channel:{id}:*` reads × 4 channels = 16 reads × 20 opens = **320 reads/day**
- **Total: ~2,400 reads/day = 2.4% of free tier**

**Writes per day (1 user, 4 channels):**
- View-refresh (throttled, see §6.4): up to 4 channels × 24 hours = **up to 96 writes/day**
- App open (~20/day × ~5 writes each): **~100 writes/day**
- One-time per subscribe: **~4 writes per new channel** (only on first add)
- **Total: ~200 writes/day = 20% of free tier**

**`KV.list()` calls: 0.** Replaced by the `channels:active` index.

**Deletes per day (cleanup):** dead-device cleanup is event-driven, not scheduled — it only fires when FCM reports a token as `UNREGISTERED`. Steady-state cost is ~0 deletes/day. A single cleanup of a device subscribed to N channels costs roughly `1 + 5N + 3N` KV ops (1 read of `device:{id}:channels` + N reads + N writes of subscriber lists + 3 + 2N deletes). In practice this is one user uninstalling every few months, well under free tier. See §11.

### 6.4 Engagement-metric write throttle (since v3.0.18, refined v3.1)

Originally, the cron re-stamped view counts on every video in the recent list on every 5-min tick, causing **~576 writes/day for 4 channels** — about 58% of the free tier just for view counts.

New policy:
- Only the **latest video's** view count is considered for writes
- Only evaluated at the top of a new hour (gated by `currentHour !== viewsLastCheckedHour`)
- Only writes if the count changed by **more than 5%** from the last stored value
- Prior videos (index 1-14) keep their last-stored view counts — view counts are slightly stale on older videos, which is fine because the newest video is the one the user actually looks at
- **v3.1**: likes and dislikes follow the same hourly top-of-list rule but with a **stricter** threshold (any change) — they're useful at any scale, so we don't wait for a 5% swing

Net effect: cron writes drop from ~576/day to ~96/day worst case, often much less.

---

## 7. Firebase Cloud Messaging (FCM)

The API worker uses FCM v1 HTTP API to push notifications. The cron worker does the same for new-video fan-out.

**Required secret:** `FIREBASE_SERVICE_ACCOUNT` (JSON blob stored in Cloudflare Workers secret manager). This is the Firebase service account key — `secrets/fcm-service-account.json` in the local repo (gitignored).

**How a push is sent:**

1. Read the service account JSON from `env.FIREBASE_SERVICE_ACCOUNT`
2. Extract the private key (PEM), strip literal `\n` escapes, base64-decode to get the PKCS8 DER
3. Build a JWT with header `{alg: 'RS256', typ: 'JWT'}` and payload `{ iss, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat, exp }`
4. Sign with the private key using RSA-SHA256
5. POST to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}` → get an OAuth access token
6. POST to `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` with the access token as a Bearer and the message payload:
   ```json
   {
     "message": {
       "token": "<device FCM token>",
       "notification": { "title": "...", "body": "..." },
       "data": { "videoId": "...", "channelId": "...", "channelName": "...", "videoLink": "..." },
       "android": { "priority": "HIGH", "notification": { "click_action": "OPEN_VIDEO" } }
     }
   }
   ```

**The FCM token can be null on `/register`.** The server accepts null tokens because the user might have denied notification permission. The device profile is still created so `/feed` and `/subscribe-channel` work. Push delivery is just disabled until a real token arrives via `onTokenRefresh`.

**Background push handler** (Android side, in `App.js`): when a push arrives while the app is in the background or killed, the handler re-fetches `/feed` and updates the local channel cache, then calls `requestWidgetUpdate` so the home-screen widget re-renders. Without this, the widget stays stale until the user opens the app.

**Dead-token detection and cleanup:** FCM returns a structured error when a token is no longer valid (user uninstalled, app data cleared, token rotated without our knowledge). The error code is `UNREGISTERED` (HTTP 404) or `NotRegistered` in the body. When `sendFCMPush` sees this, it returns `{ sent: false, deadToken: true }` to the caller, which then calls `cleanupDeadDevice()` to remove the device's full state. Other error codes (`INVALID_ARGUMENT`, `INTERNAL`, `UNAVAILABLE`, `SENDER_ID_MISMATCH`) are transient or config errors and do **not** trigger cleanup — see §11 for the full policy.

---

## 8. Local development

### 8.1 Running a worker locally

```bash
# In worker/tubepulse-api/ or worker/tubepulse-cron/
source ../../secrets/load-secrets.sh   # sets CLOUDFLARE_* and YOUTUBE_API_KEY
npx wrangler dev                       # starts local miniflare on port 8787
```

The local miniflare has its own KV simulator. The state is cached in `worker/*/.wrangler/state/v3/kv/...` — gitignored.

**Secrets permissions:** the `secrets/` directory contains live credentials. The whole directory is gitignored (see `.gitignore` line 23), so perms are not enforced by git. After copying or creating the files, run `chmod 600 secrets/*.env secrets/*.json` and `chmod 700 secrets/*.sh` to make them private to your user. On Windows-native or NTFS-mounted filesystems (e.g. `/mnt/d/...` in WSL) the POSIX mode bits are ignored — security is then controlled by Windows ACLs.

### 8.2 Deploying to production

```bash
cd worker/tubepulse-cron
source ../../secrets/load-secrets.sh
npx wrangler deploy
```

This uploads the worker and triggers a redeploy. The `triggers.crons` config in `wrangler.toml` controls the schedule.

### 8.3 Pushing secrets to a worker

```bash
./secrets/set-worker-secrets.sh tubepulse-api
./secrets/set-worker-secrets.sh tubepulse-cron
```

This pushes `YOUTUBE_API_KEY` and `FIREBASE_SERVICE_ACCOUNT` to the worker's secret manager via `wrangler secret put`. Run it once on initial setup and again any time those secrets change.

### 8.4 Tailing live logs

```bash
cd worker/tubepulse-cron
source ../../secrets/load-secrets.sh
npx wrangler tail
```

Live-streamed logs from the deployed worker. Useful for watching a cron tick fire or debugging an FCM error.

---

## 9. Common operations

### Adding a new endpoint to the API worker

1. Add the handler function in `worker/tubepulse-api/index.js` (use the existing `handleX(request, env, ctx)` pattern)
2. Add a route entry in the main router near line 1729 (look for `path === '/...'` blocks)
3. Test with `npx wrangler dev` and curl
4. Deploy with `npx wrangler deploy`

### Adding a new scheduled job

1. Add the function in `worker/tubepulse-cron/index.js` (e.g. `runXxxCron(env)`)
2. Add a `if (mins % N === 0) { results.xxx = await runXxxCron(env); }` block in the main `scheduled()` handler
3. Test by tailing and waiting for the next matching tick
4. Deploy with `npx wrangler deploy`

### Rotating the FCM service account

1. Generate a new key in the Firebase console: `https://console.firebase.google.com/project/tubepulse-470a1/settings/serviceaccounts/adminsdk`
2. Save the new JSON to `secrets/fcm-service-account.json` (overwrite)
3. Verify the new key is the right size: `node -e "const k=JSON.parse(require('fs').readFileSync('secrets/fcm-service-account.json','utf8')); const b=Buffer.from(k.private_key.replace(/-----[^-]+-----|\n/g,''),'base64'); console.log('PKCS8 DER bytes:', b.length);"` — should print `1217`. Anything else is corrupted.
4. Push: `./secrets/set-worker-secrets.sh tubepulse-api && ./secrets/set-worker-secrets.sh tubepulse-cron`
5. Test by triggering a push (next cron tick with a new video, or manually: `curl -X POST https://tubepulse-api.jimothyoakley55.workers.dev/register` etc. — note: this URL is no longer reachable since the API worker has `routes = []`; use `wrangler dev` or invoke from the cron via a service binding instead)

### Debugging KV state

The KV namespace is shared and not directly inspectable from the CLI. To see what's in there:
- Add temporary `console.log(...)` calls in the worker, deploy, and tail
- Or write a one-shot debug endpoint that returns specific keys
- For a quick check, the API worker's `/feed` returns the current state for a given device

### Manually forcing a dead-device cleanup (for testing)

1. Get a real FCM token from a device (e.g. by tailing the API worker's logs while the app registers)
2. Kill the token via FCM: `curl -X POST -H "Authorization: Bearer <oauth-token>" -H "Content-Type: application/json" -d '{"tokens":["<fcm-token>"]}' "https://fcm.googleapis.com/v1/projects/tubepulse-470a1/tokens:batchDelete"`
3. Plant the test token on a test device via `POST /register` with that token
4. Subscribe the test device to a real channel via `POST /subscribe-channel`
5. Trigger a WebSub push for that channel (curl a fake `<feed>` XML to `POST /websub`)
6. Tail the API worker's logs — you should see `[Cleanup] device ...` and `[Cleanup] channel ...` lines within ~5 seconds

The cleanup helpers are also unit-testable by adding a temp `POST /_test_cleanup` endpoint that takes a deviceId in the body — verified this way during the v3.0.18 deploy, then the endpoint was removed.

### Monitoring free tier usage

Cloudflare's dashboard shows daily usage: `https://dash.cloudflare.com/<account_id>/workers/overview`. KV usage is at `https://dash.cloudflare.com/<account_id>/storage/kv`. YouTube Data API quota is at `https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas`.

---

## 10. File layout

```
worker/
├── README.md                  ← you are here
├── index.js                   ← legacy/older single-worker file (not deployed)
├── tubepulse-api/
│   ├── index.js               ← API worker source (1774 lines as of v3.1.6)
│   └── wrangler.toml          ← deployment config
└── tubepulse-cron/
    ├── index.js               ← cron worker source (1503 lines as of v3.1.6)
    └── wrangler.toml          ← deployment config

secrets/                       ← live credentials, ALL gitignored
├── cloudflare.env             ← CF account ID + API token
├── youtube.env                ← YouTube Data API key
├── fcm-service-account.json   ← Firebase service account
├── load-secrets.sh            ← sources env + generates .dev.vars
├── set-worker-secrets.sh      ← pushes secrets to worker via wrangler
└── README.md                  ← operator docs for secrets
```

The actual KV namespace, Firebase project, and Cloudflare account are not in this repo — they're configured in the workers' `wrangler.toml` (account ID) and the secrets/ directory.

---

## 11. Dead-device cleanup

Both workers implement the same two helpers to remove state for channels and devices that no longer need it:

```js
async function cleanupDeadChannel(channelId, env, reason)
// Deletes channel:{id}:meta, channel:{id}:recent, channel:{id}:websub,
// channel:{id}:subscribers (the empty list left after the last
// subscriber left — v3.0.19 fix to avoid KV orphans)
// Removes channelId from channels:active
// Idempotent. Safe to call on a never-cached channel.

async function cleanupDeadDevice(deviceId, env, reason)
// Reads device:{id}:channels to find every channel the device was on
// For each: removes the device from that channel's subscribers list
//   - if the list goes empty, also calls cleanupDeadChannel
// Deletes device:{id}:profile, :settings, :channels
// Deletes device:{id}:state:{channelId} + :override:{channelId} for each channel
// Idempotent. Safe to call on a never-registered device.
```

**Trigger policy:**

| Trigger | Action | Deletes device profile? |
|---------|--------|-------------------------|
| FCM returns `UNREGISTERED` (HTTP 404) on a push to a device's token | `cleanupDeadDevice(deviceId, env, 'fcm_unregistered')` | **Yes** |
| `/unsubscribe` and the device was the last subscriber on that channel | `cleanupDeadChannel(channelId, env, 'unsubscribe_last')` | **No** — the device profile is preserved so the user can re-subscribe |
| Any other FCM error (`INVALID_ARGUMENT`, `INTERNAL`, `UNAVAILABLE`, `SENDER_ID_MISMATCH`) | No cleanup | n/a — these are transient or config errors, not dead devices |
| App opens with no FCM token (user denied permission) | No cleanup | n/a — the device profile is intentionally retained for `/feed` and `/subscribe-channel` to work |
| Time-based / scheduled cleanup | **None** | n/a — cleanup is purely event-driven |

**Why so conservative?** FCM holds messages for up to 28 days for offline devices. If a phone is off / out of credit / has Do Not Disturb blocking background data, the push will still be delivered when the device comes back. We only cleanup when FCM explicitly tells us the token is gone, which is the only unambiguous signal that the device is unrecoverable.

**Why no time-based expiry for unused channels?** Same reason — the user might be on holiday, between projects, or temporarily using a different device. The KV cost of a few hundred cached channels is negligible; the user-experience cost of "I came back and my watch list is empty" is high.

**Where the helpers live:** `cleanupDeadChannel` and `cleanupDeadDevice` are defined in **both** `worker/tubepulse-api/index.js` and `worker/tubepulse-cron/index.js`. The API-worker copy is for the WebSub push path; the cron-worker copy is for the three scheduled jobs (`runRssPollCron`, `runNagCron`, `runUpcomingCron`). The cron copy uses the `deleteKV` wrapper so deletes count toward the worker's `kvOps` totals (§6.3).

**Idempotency and races:** `kv.delete()` is a no-op on missing keys. If both workers detect the same dead device in the same window (e.g. WebSub push and a 5-min cron tick both call `cleanupDeadDevice` for the same `deviceId`), the second call is essentially free — a few extra reads, a few no-op deletes, no data corruption. The worst case is a small amount of double-counted KV ops in the wrangler tail.

**Log format:** every cleanup emits a single structured line. Watch for sudden spikes — >5 cleanups in a day usually means an app-version bug, a mass uninstall, or someone manually nuking test devices:

```
[Cleanup] channel <id>: reason=<reason> deletedKeys=3 removedFromActive=true
[Cleanup] device <id>: reason=<reason> channelsAffected=<n> channelsCleaned=<n> devicesDeleted=<n>
```

Reason values you may see:
- `fcm_unregistered` — FCM told us the token is dead
- `unsubscribe_last` — the user removed a channel they were the only one watching
- `last_subscriber_dead` — fired inside `cleanupDeadDevice` when removing a dead device empties a channel

**Manually triggering cleanup for testing:** neither worker exposes a public endpoint for this (we don't want arbitrary callers able to nuke device state). For dev/test, use a one-shot script that reads a real FCM token, calls the FCM `tokens:batchDelete` API to kill it, then triggers a WebSub push. The `v3.0.18` release verified the helper end-to-end via a temporary `/_test_cleanup` endpoint that was removed before final deploy.

### 11.1 Device-ID migration on `register`

The client-side `getDeviceId()` is a stable identifier for a given install — but its source has changed over time:

- **v3.0.18**: random UUID stored in AsyncStorage (prone to races that could mint two UUIDs for the same install)
- **v3.0.19**: Android's `Application.getAndroidId()` (per-app-install, stable, but fingerprintable)
- **v3.0.20** → **v3.1.x (current)**: `expo-secure-store` UUID (random, encrypted in Android Keystore / iOS Keychain, hardware-backed on most devices, wiped on uninstall). The current shipping app uses this.

When an existing user upgrades across a version boundary, their `deviceId` changes (e.g. `android:abc...` → `secure:xyz...`), but the FCM token stays the same. Without migration, the user's channels would appear "lost" on upgrade.

When an existing user upgrades across a version boundary, their `deviceId` changes (e.g. `android:abc...` → `secure:xyz...`), but the FCM token stays the same. Without migration, the user's channels would appear "lost" on upgrade.

`/register` runs a two-phase migration to handle this:

1. **Fast path — `fcm:lookup:{fcmToken}` index**: read the index. If it points to a different `deviceId` than the one currently registering, call `migrateDevice(oldId, newId, env)`. This is the common case for cross-version upgrades (v3.0.18→v3.0.19, v3.0.19→v3.0.20).
2. **Slow path — full profile scan**: if the lookup is missing (e.g. rotated FCM token wiped the lookup, or the old device was registered before the index existed), `kv.list({ prefix: 'device:' })` and inspect each profile. For every profile whose `fcmToken` matches the registering token, call `migrateDevice(oldId, newId, env)`. This catches:
   - The v3.0.18 duplicate-UUID race (two old devices, same FCM token) — both get merged into the new device
   - Any case where a user's previous install was on a build that didn't maintain the lookup index

The scan is one `kv.list` per `register` call, costing ~1 KV op per app launch. Negligible against the 100k/day free tier.

**`migrateDevice(oldId, newId, env)`** does the following atomically:
- Reads old device's `channels`, `settings`, and per-channel `state:*` / `override:*`
- For each channel the old device was on: ensures the new device is in that channel's `subscribers` list (and the old device is removed from it)
- Copies per-channel `state:*` and `override:*` to the new device (new device takes precedence if it already has a value)
- Writes the union of old + new channel lists to `device:{newId}:channels`
- Copies old device's `settings` to the new device (new device takes precedence)
- Calls `cleanupDeadDevice(oldId, env, 'migrated_to_new_device')` to clean up the old device's profile/settings/channels/state/override and its `fcm:lookup` entry

**Settings merge rule:** when both old and new devices have settings, the new device's settings are kept. Rationale: the user just installed the new version, so the latest settings (which may have been edited through the new version) are what they want.

**What survives the migration:** the new device's `profile.fcmToken`, `profile.platform`, `profile.appVersion`, `profile.createdAt`, `profile.lastSeenAt`. Migration does NOT copy the old profile — only the channels, settings, and per-channel state. The new device is the canonical install going forward.

**Verified end-to-end** during the v3.0.19 development cycle: two stale device profiles (`974444b4-...`, `5ffc51a1-...`) from the v3.0.18 duplicate-UUID race, both pointing to the same FCM token, were merged into a single new `android:*` device in a single `register` call. All 4 channels survived. The scan-based migration found both old devices and the lookup-based migration found the most recently registered one — they cooperated correctly.

