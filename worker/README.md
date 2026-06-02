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
| `tubepulse-api` | `https://tubepulse-api.jimothyoakley55.workers.dev` | HTTP API for the app + dormant WebSub callback |
| `tubepulse-cron` | `https://tubepulse-cron.jimothyoakley55.workers.dev` | Scheduled jobs (every 5 min): upcoming events, RSS poll, nag cycle |
| `TUBEPULSE_KV` | KV namespace `52e77ca9f5f6493e89d2478c8d3055ec` | All persistent state |

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

`worker/tubepulse-cron/index.js` — deployed via `wrangler deploy` in `worker/tubepulse-cron/`.

**Schedule:** `*/5 * * * *` (every 5 minutes), configured in `wrangler.toml`.

The worker has **one** `scheduled()` handler that dispatches to four jobs based on the current minute:

| Job | Trigger | Function | What it does |
|-----|---------|----------|--------------|
| 1. Upcoming events | every 5 min | `runUpcomingCron` | Reads `upcoming:{bucket}` for the current 5-min window. Fires "live soon" and "is live" FCM pushes for scheduled livestreams. |
| 2. RSS poll | every 5 min | `runRssPollCron` | Reads `channels:active`, fetches RSS feed for each channel, diffs against `channel:{id}:recent`. New videos → FCM fan-out. |
| 3. Nag cycle | every 15 min | `runNagCron` | Reads `nag:{bucket}` for the current 15-min window. Re-notifies devices about unwatched videos per their nag settings. |
| 4. Lease renewal | every 6 hours | `runLeaseCron` | **Dormant no-op** — Google's PubSubHubbub hub was shut down in 2024. Code path remains for future revival. |

### 3.1 RSS poll — the active new-video detection path

Since WebSub hub shutdown, the cron detects new videos by polling YouTube's public RSS feed:

```
https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx
```

Each entry in the Atom feed carries: `videoId`, `title`, `publishedAt`, `thumbnail`, `link`, and **view count** (from `media:community/media:statistics/@_views`).

**Flow per channel per tick:**

1. Read `channels:active` (KV list)
2. For each channelId:
   - GET the RSS feed (with `User-Agent` + `SOCS` cookie to bypass the EU/UK consent wall)
   - Parse with a regex-based Atom parser (no XML library needed in the worker)
   - Read `channel:{id}:recent` from KV
   - Find videos in RSS that aren't in `recent` → new videos
   - For new videos: write updated `channel:{id}:recent` and `channel:{id}:meta`, then look up subscribers and fan out FCM pushes
3. Truncate `recent` to 15 entries

**Quota cost: 0 YouTube Data API units.** RSS is a free public feed. Cloudflare KV cost: ~1 read per channel per tick, with writes only when a new video is detected or a view count crosses the 5% threshold (see §6.4 below).

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

`worker/tubepulse-api/index.js` — deployed via `wrangler deploy` in `worker/tubepulse-api/`.

**No schedule** — pure HTTP. The single entry point is `fetch(request, env, ctx)`, which routes by `path` and `request.method`.

### 4.1 Endpoint map

| Method | Path | Auth | Function | Purpose |
|--------|------|------|----------|---------|
| `GET`  | `/` | none | `handleRoot` | Health check (returns version + architecture) |
| `POST` | `/register` | Bearer | `handleRegister` | Create/update device profile (FCM token optional) |
| `POST` | `/subscribe-channel` | Bearer | `handleSubscribeChannel` | Add a channel, fetch its avatar via Data API, fan-out RSS bootstrap |
| `POST` | `/unsubscribe` | Bearer | `handleUnsubscribe` | Remove a channel, clean up subscriber list and active index |
| `POST` | `/seen` | Bearer | `handleSeen` | Mark a video (or all videos on a channel) as watched |
| `GET`  | `/feed` | Bearer | `handleFeed` | Return recent videos across all subscribed channels |
| `GET`  | `/resolve` | Bearer | `handleResolve` | `@handle` → channelId (Data API, cached 7 days) |
| `POST` | `/bootstrap` | Bearer | `handleBootstrap` | On-demand channel meta + recent videos refresh |
| `POST` | `/settings` | Bearer | `handleSettings` | Update device notification settings |
| `POST` | `/channel-override` | Bearer | `handleChannelOverride` | Set per-channel notification override |
| `GET`  | `/websub` | none | `handleWebSubVerification` | WebSub handshake (dormant) |
| `POST` | `/websub` | HMAC | `handleWebSubPush` | WebSub push delivery (dormant) |
| `OPTIONS` | * | none | CORS preflight | Allow the Android app to call any path |

**Auth model:** Every authenticated endpoint requires `Authorization: Bearer <deviceId>`. The `deviceId` is a UUID generated on first launch and stored in `AsyncStorage`. There is no login — the deviceId *is* the auth token. This is acceptable because the KV is private and the deviceId is unguessable (UUIDv4).

### 4.2 Bootstrap-on-subscribe (the most important code path)

When a new device subscribes to a channel, the API worker does **the only work that uses the YouTube Data API at subscribe time**:

1. **Resolve channel via Data API** (`channels.list?part=snippet&forHandle=...` or `forUsername=...`) — 1 quota unit, returns channelId + name + avatar URL in one call
2. **Fetch recent videos via RSS** — 0 quota units, returns up to 15 videos with view counts
3. Cache the channel meta + recent list in KV
4. Add the channel to `channels:active` (if this device is the first subscriber)
5. Try a dormant WebSub subscription (no quota cost, just a POST that 404s — kept for future hub revival)

**The YouTube Data API is called twice in the worst case** (resolve + search), but both results are cached: handle→channelId is cached 7 days, channel meta+avatar is cached forever in `channel:{id}:meta`. **After subscribe, the cron takes over and never touches the Data API again.**

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
| `channel:{channelId}:recent` | JSON array | `[{ videoId, title, publishedAt, thumbnail, type, link, views, viewsLastCheckedHour? }]` | Cron (RSS poll) | API (feed, bootstrap), API (subscribe for first-time populate) |
| `device:{deviceId}:profile` | JSON | `{ fcmToken, platform, appVersion, createdAt, lastSeenAt }` | API (register) | API (any auth call), Cron (FCM fan-out) |
| `device:{deviceId}:settings` | JSON | `{ mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, dndBypass, tapAction, ... }` | API (settings) | Cron (FCM fan-out filter) |
| `device:{deviceId}:channels` | JSON array | `[channelId, ...]` | API (subscribe, unsubscribe) | API (feed filter) |
| `device:{deviceId}:override:{channelId}` | JSON | per-channel notification override | API (channel-override) | Cron (FCM fan-out filter) |
| `device:{deviceId}:state:{channelId}` | JSON | `{ unwatched: [videoId], lastNagAt, nagCount }` | Cron (new video, nag fire) | Cron (nag fire, seen cleanup) |
| `upcoming:{bucket}` | JSON array | scheduled livestream entries | Cron (RSS poll, new video) | Cron (upcoming cron) |
| `nag:{bucket}` | JSON array | pending nag entries | Cron (nag fire, reschedule) | Cron (nag cron) |
| `channels:active` | JSON array | `[channelId, ...]` — index of channels with ≥1 subscriber | API (subscribe, unsubscribe) | Cron (RSS poll) |
| `handle:{lowercase}` | JSON | `{ channelId, cachedAt }` | API (resolve) | API (resolve) |

**`channels:active` is the secret sauce.** It replaces a `KV.list()` call — the only way to know "which channels have at least one subscriber" without scanning the entire namespace. The cron reads this list, processes each channel, done. No `list()`.

---

## 6. Cost analysis (1 user, 4 channels)

### 6.1 YouTube Data API (free tier: 10,000 units/day)

| Operation | Quota units | When |
|-----------|-------------|------|
| `/resolve` (`channels.list?part=snippet&forHandle=...`) | 1 unit | Per unique handle, cached 7 days |
| `handle:*` cache hit | 0 units | Subsequent lookups for the same handle |
| Subscribe-time avatar fetch (in `/subscribe-channel`) | 1 unit | Per new channel added (one-time, cached forever in `channel:{id}:meta`) |
| Cron tick (RSS-based) | **0 units** | RSS feed has no API key requirement |
| **Total steady-state** | **~0 units/day** | Only spend units on first-subscribe events |

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

### 6.4 View-count write throttle (since v3.0.18)

Originally, the cron re-stamped view counts on every video in the recent list on every 5-min tick, causing **~576 writes/day for 4 channels** — about 58% of the free tier just for view counts.

New policy:
- Only the **latest video's** view count is considered for writes
- Only evaluated at the top of a new hour (gated by `currentHour !== viewsLastCheckedHour`)
- Only writes if the count changed by **more than 5%** from the last stored value
- Prior videos (index 1-14) keep their last-stored view counts — view counts are slightly stale on older videos, which is fine because the newest video is the one the user actually looks at

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

---

## 8. Local development

### 8.1 Running a worker locally

```bash
# In worker/tubepulse-api/ or worker/tubepulse-cron/
source ../../secrets/load-secrets.sh   # sets CLOUDFLARE_* and YOUTUBE_API_KEY
npx wrangler dev                       # starts local miniflare on port 8787
```

The local miniflare has its own KV simulator. The state is cached in `worker/*/.wrangler/state/v3/kv/...` — gitignored.

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
2. Add a route entry in the main router near line 1367 (look for `path === '/...'` blocks)
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
5. Test by triggering a push (next cron tick with a new video, or manually: `curl -X POST https://tubepulse-api.jimothyoakley55.workers.dev/register` etc.)

### Debugging KV state

The KV namespace is shared and not directly inspectable from the CLI. To see what's in there:
- Add temporary `console.log(...)` calls in the worker, deploy, and tail
- Or write a one-shot debug endpoint that returns specific keys
- For a quick check, the API worker's `/feed` returns the current state for a given device

### Monitoring free tier usage

Cloudflare's dashboard shows daily usage: `https://dash.cloudflare.com/<account_id>/workers/overview`. KV usage is at `https://dash.cloudflare.com/<account_id>/storage/kv`. YouTube Data API quota is at `https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas`.

---

## 10. File layout

```
worker/
├── README.md                  ← you are here
├── index.js                   ← legacy/older single-worker file (not deployed)
├── tubepulse-api/
│   ├── index.js               ← API worker source (~1400 lines)
│   └── wrangler.toml          ← deployment config
└── tubepulse-cron/
    ├── index.js               ← cron worker source (~1000 lines)
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
