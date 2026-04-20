# TubePulse — Project Status

**Last updated:** 2026-04-20  
**Current version:** 3.0.0 (architecture migration, not yet built/deployed)  
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)  
**Platform:** Android only (React Native + Expo)

---

## Current State

### Workers: OFFLINE (v2 workers deleted, v3 written but not yet deployed)
Both Cloudflare Workers have been rewritten to v3 channel-first architecture.

- `tubepulse-api` — REST API + WebSub callback (v3 written, not deployed)
- `tubepulse-cron` — Time-bucket driven cron: upcoming/nag/lease (v3 written, not deployed)

**KV namespace** (`f2ac3fd3ae9c457287074e7e32c66c64`) still exists with v2 data.

### App: v3 API client updated, not yet built
- `api.js` updated to v3 endpoints
- `App.js` updated for new `/register` (profile-only) and notification tap handling
- `HomeScreen.js` updated for new `/feed` response format
- `ChannelsScreen.js` updated for per-channel subscribe/unsubscribe + channel-override
- Widget, storage, constants, FCM unchanged (compatible)

---

## v3.0 Architecture Changes

### What changed
- **Channel-first**: All operations start from channel, fan out to subscribers
- **Zero `KV.list()`**: Replaced by `channels:active` index and time buckets
- **Split device blob**: Device data spread across separate keys (profile, settings, channels, state, override)
- **Time buckets**: `upcoming:{bucket}` and `nag:{bucket}` drive cron jobs event-style
- **Per-channel endpoints**: `POST /subscribe-channel` + `POST /unsubscribe` replace `PUT /channels`
- **Per-channel override**: New `POST /channel-override` endpoint
- **Handle caching**: `handle:{lowercase}` keys with 7-day TTL
- **15 recent videos** per channel (was 5)

### What didn't change
- WebSub push detection (same Atom XML parsing)
- FCM notification delivery (same payload structure)
- DND logic (same isDndActive)
- App UI (same screens, same local storage)
- Widget (unchanged)

---

## Next Steps

### Immediate
1. [ ] Deploy v3 workers to Cloudflare
2. [ ] Set cron schedule: `*/5 * * * *`
3. [ ] Clear old v2 KV data (device:, channel:, feed:, sub: prefixes)
4. [ ] Build v3.0.0 APK and test
5. [ ] Test: channel add → subscribe → WebSub → push → notification
6. [ ] Test: nag bucket → cron → re-notification
7. [ ] Test: scheduled event → upcoming bucket → notification
8. [ ] Test: unsubscribe → WebSub unsubscribe
9. [ ] Monitor KV usage for 24h

### Known issues from v2 (should be fixed by v3)
- ✅ Notification spam (nag state not updated) — v3 uses time buckets with state re-check
- ✅ Channel tap not clearing state — v3 clears state per-channel
- ✅ KV list ops hitting limits — v3 has zero list ops
- ✅ Device iteration on every cron tick — v3 uses event-driven buckets

### Short-term improvements
- [ ] Shorts filtering via YouTube Data API `contentDetails`
- [ ] Privacy policy for Play Store submission
- [ ] Weekly consistency check cron (clean up orphaned device keys)

### Future
- [ ] Nag cycle scaling if user base grows beyond 100 devices
- [ ] Livestream detection via YouTube Data API `liveStreamingDetails`
- [ ] iOS support (APNs integration)

---

## Cloudflare Free Tier Limits

| Resource | Limit | v3 Expected Usage |
|----------|-------|-------------------|
| KV reads | 100,000/day | ~3,000/day (channel-first, 100x less than v2) |
| KV writes | 1,000/day | ~200/day |
| KV list ops | 1,000/day | **0** (channels:active index replaces all) |
| KV storage | 1 GB | < 1 MB |
| Worker requests | 100,000/day | ~500/day |
| Worker CPU time | 10 ms per invocation | < 5 ms |

---

## Version History

| Version | Date | Key Changes |
|---------|------|-------------|
| v2.1.0 | 2026-04-18 | WebSub push architecture, UUID auth, HMAC verification |
| v2.2.0 | 2026-04-18 | DND batching, per-channel notification overrides |
| v2.3.0 | 2026-04-19 | Default notification mode → chill, comprehensive README |
| v2.4.3 | 2026-04-19 | Batch nag state fix, notification dedup, /seen state clearing, bootstrap fixes |
| v3.0.0 | 2026-04-20 | **Channel-first architecture**: zero KV.list(), time buckets, split device keys, per-channel endpoints |