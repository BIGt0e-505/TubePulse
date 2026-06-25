/**
 * TubePulse Cron Worker - v3.0 (channel-first architecture)
 *
 * Three scheduled jobs:
 *   - Every 5 min: Upcoming events (check time buckets for scheduled livestreams)
 *   - Every 15 min: Nag cycle (check nag buckets, re-notify unwatched videos)
 *   - Every 6h on the hour: Lease renewal (renew WebSub subscriptions expiring within 24h)
 *
 * Architecture: time-bucket driven. No KV.list() calls anywhere.
 * Each job reads the bucket for "now" and processes entries.
 */

// ÔöÇÔöÇÔöÇ Key builders (must match API worker) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

const key = {
  channelMeta:      (channelId) => `channel:${channelId}:meta`,
  channelSubs:      (channelId) => `channel:${channelId}:subscribers`,
  channelWebsub:    (channelId) => `channel:${channelId}:websub`,
  channelRecent:    (channelId) => `channel:${channelId}:recent`,
  channelRecentPosts: (channelId) => `channel:${channelId}:recent:posts`,
  firstPollAtPosts: (channelId) => `channel:${channelId}:firstPollAt:posts`,
  deviceProfile:    (deviceId)  => `device:${deviceId}:profile`,
  deviceSettings:   (deviceId)  => `device:${deviceId}:settings`,
  deviceChannels:   (deviceId)  => `device:${deviceId}:channels`,
  deviceOverride:   (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState:      (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  fcmLookup:        (fcmToken)  => `fcm:lookup:${fcmToken}`,
  upcoming:         (bucket)    => `upcoming:${bucket}`,
  nag:              (bucket)    => `nag:${bucket}`,
  channelsActive:   ()          => `channels:active`,
  // Per-user prewarn tracking. Set to the prewarnMinutes value when the
  // prewarn push has been sent. Keyed by (event videoId, deviceId) so
  // each device gets at most one prewarn per event. Cleaned up when
  // the event is past.
  prewarnSent:      (videoId, deviceId) => `upcoming:prewarn:${videoId}:${deviceId}`,
  // List of all currently-scheduled live events. Append-only on
  // detection; cleaned in runUpcomingCron when an event is past its
  // scheduledFor + 24h.
  upcomingEvents:   ()          => `upcoming:events:list`,
};

// KV operation counters ÔÇö incremented on every get/put/delete and logged
// at the end of each scheduled tick. Lets us watch free-tier usage in
// the wrangler tail without needing Cloudflare Analytics Engine access.
// Resets at the start of every scheduled() call.
const kvOps = { reads: 0, writes: 0, deletes: 0, lists: 0 };

async function getKV(kv, k) { kvOps.reads++; return await kv.get(k, 'json'); }
async function putKV(kv, k, value) { kvOps.writes++; await kv.put(k, JSON.stringify(value)); }
async function deleteKV(kv, k) { kvOps.deletes++; await kv.delete(k); }
// Note: kv.list() isn't called anywhere in this worker (the channels:active
// index replaces it). If it ever is, the counter is here and ready.

// ÔöÇÔöÇÔöÇ Cleanup helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// Identical logic to the API worker's cleanup helpers. Kept in sync so
// both workers can clean up dead devices/channels the same way.
//
// Idempotent: kv.delete() on a missing key is a no-op. If the API and
// cron workers race to clean up the same dead device (e.g. WebSub push
// and RSS poll both detect UNREGISTERED in the same window), we just
// log the duplicate and move on.
//
// Logging: every cleanup emits a single console.log with reason + counts.
// Watch for sudden spikes (likely an app-version bug or mass uninstall).

/**
 * Remove a channel's cached state once it has zero subscribers.
 * Idempotent. Safe to call even if the channel was never cached.
 */
async function cleanupDeadChannel(channelId, env, reason = 'last_subscriber_dead') {
  const kv = env.TUBEPULSE_KV;
  let deletedKeys = 0;

  await deleteKV(kv, key.channelMeta(channelId));
  deletedKeys++;
  await deleteKV(kv, key.channelRecent(channelId));
  deletedKeys++;
  await deleteKV(kv, key.channelRecentPosts(channelId));
  deletedKeys++;
  await deleteKV(kv, key.firstPollAtPosts(channelId));
  deletedKeys++;
  await deleteKV(kv, key.channelWebsub(channelId));
  deletedKeys++;
  await deleteKV(kv, key.channelSubs(channelId));
  deletedKeys++;
  const active = await getKV(kv, key.channelsActive()) || [];
  const filtered = active.filter((id) => id !== channelId);
  const removedFromActive = filtered.length !== active.length;
  if (removedFromActive) {
    await putKV(kv, key.channelsActive(), filtered);
  }

  console.log(`[Cleanup] channel ${channelId}: reason=${reason} deletedKeys=${deletedKeys} removedFromActive=${removedFromActive}`);
  return { deletedKeys, removedFromActive };
}

/**
 * Remove a device's full state once FCM has reported it dead (UNREGISTERED).
 * Also cleans up every channel the device was subscribed to ÔÇö and if any
 * of those channels go from N=1 to N=0 subscribers, the channel is also
 * cleaned via cleanupDeadChannel.
 *
 * Idempotent. Safe to call on a device that was never registered.
 */
async function cleanupDeadDevice(deviceId, env, reason = 'fcm_unregistered') {
  const kv = env.TUBEPULSE_KV;

  // 0. Read the profile so we can clean the FCM-token lookup index below.
  //    Missing profile does not stop cleanup; device:{id}:channels may still exist.
  const profile = await getKV(kv, key.deviceProfile(deviceId));

  // 1. Find every channel this device was on.
  const channels = await getKV(kv, key.deviceChannels(deviceId)) || [];
  let channelsCleaned = 0;

  // 2. For each channel, remove the device from its subscribers list.
  //    If the list goes empty, the channel is also fully cleaned up.
  for (const channelId of channels) {
    const subs = await getKV(kv, key.channelSubs(channelId)) || [];
    const filtered = subs.filter((id) => id !== deviceId);
    await putKV(kv, key.channelSubs(channelId), filtered);

    if (filtered.length === 0 && subs.length > 0) {
      await cleanupDeadChannel(channelId, env, 'last_subscriber_dead');
      channelsCleaned++;
    }
  }

  // 3. Delete the device's own state. We do this last so a failure in
  //    step 2 leaves the device profile intact and the next push will
  //    retry the cleanup.
  let devicesDeleted = 0;
  const deviceKeys = [
    key.deviceProfile(deviceId),
    key.deviceSettings(deviceId),
    key.deviceChannels(deviceId),
  ];
  for (const k of deviceKeys) {
    await deleteKV(kv, k);
    devicesDeleted++;
  }

  if (profile?.fcmToken) {
    await deleteKV(kv, key.fcmLookup(profile.fcmToken));
  }
  // 4. Delete per-channel state + override. We don't know the channel
  //    list any more (we just deleted :channels), so iterate the list
  //    we captured in step 1.
  for (const channelId of channels) {
    await deleteKV(kv, key.deviceState(deviceId, channelId));
    await deleteKV(kv, key.deviceOverride(deviceId, channelId));
    devicesDeleted += 2;
  }

  console.log(`[Cleanup] device ${deviceId}: reason=${reason} channelsAffected=${channels.length} channelsCleaned=${channelsCleaned} devicesDeleted=${devicesDeleted}`);
  return { channelsCleaned, devicesDeleted };
}

// ÔöÇÔöÇÔöÇ DND logic ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function isDndActive(dndStart, dndEnd, timezone = 'UTC') {
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  // Get the current hour/minute in the device's timezone (Intl is available in
  // the Workers JS runtime). Falls back to UTC if the tz string is invalid.
  let nowMins;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const hh = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const mm = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    nowMins = hh * 60 + mm;
  } catch {
    const now = new Date();
    nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}

// ÔöÇÔöÇÔöÇ Time bucket helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function currentUpcomingBucket() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16);
}

function currentNagBucket() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16);
}

function nagBucket(timestampMs) {
  const d = new Date(timestampMs);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16);
}

function upcomingBucket(isoDate) {
  const d = new Date(isoDate);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16);
}

function classifyVideo(entry) {
  if (!entry.published) return 'video';
  const publishedTime = new Date(entry.published).getTime();
  const now = Date.now();
  // Future-dated ÔåÆ live_scheduled (premieres / scheduled livestreams)
  if (publishedTime > now + 5 * 60 * 1000) return 'live_scheduled';
  const title = (entry.title || '').toLowerCase();
  if (title.startsWith('­ƒö┤') || title.includes(' live')) return 'live';
  return 'video';
}

// ÔöÇÔöÇÔöÇ YouTube Data API helpers (RSS feeds are 404 as of 2024-2025) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// PubSubHubbub (WebSub) hub was also shut down by Google.
// ÔòöÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòù
// Ôòæ  DEAD CODE ÔÇö v3.0.18                                                 Ôòæ
// Ôòæ                                                                      Ôòæ
// Ôòæ  These three functions used to power the YouTube Data API poller.   Ôòæ
// Ôòæ  runRssPollCron now uses RSS exclusively (see parseRSSFeed +         Ôòæ
// Ôòæ  fetchChannelRSS above and runRssPollCron below), so the YouTube    Ôòæ
// Ôòæ  Data API is no longer called from the cron worker at all.          Ôòæ
// Ôòæ                                                                      Ôòæ
// Ôòæ  The cron tick used to cost ~2 quota units per channel per 5-min.   Ôòæ
// Ôòæ  It now costs 0 quota units. The YouTube Data API is only used     Ôòæ
// Ôòæ  from the API worker, and only at subscribe time (one-time).        Ôòæ
// Ôòæ                                                                      Ôòæ
// Ôòæ  Kept here for reference. Can be deleted safely.                    Ôòæ
// ÔòÜÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòØ

// Fallback: poll YouTube Data API for each active channel every 5 minutes.
// Cost: 1 unit per channels.list (once per channel to get uploads playlist ID,
//       result cached in channel meta) + 1 unit per playlistItems.list call.
// Default daily quota is 10,000 units, so 5,000 channel-polls/day on a fresh
// install; 16,000+ once playlist IDs are cached.

async function getUploadsPlaylistId(apiKey, channelId) {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    return uploads || null;
  } catch (err) {
    console.error(`[YTData] channels.list error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getRecentUploadsFromPlaylist(apiKey, playlistId, maxResults = 10) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=${maxResults}&key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.items?.length) return [];

    return data.items.map((item) => {
      const s = item.snippet || {};
      const thumbs = s.thumbnails || {};
      const videoId = s.resourceId?.videoId;
      return {
        videoId,
        title: s.title,
        published: s.publishedAt,
        thumbnail: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
        link: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        channelTitle: s.channelTitle,
      };
    }).filter((v) => v.videoId);
  } catch (err) {
    console.error(`[YTData] playlistItems error:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Batched view-count lookup. Returns { [videoId]: "12345" } string view counts.
// Costs 1 quota unit per call (up to 50 video IDs at once).
// Returns null on quota/connection error so the caller can degrade gracefully.
async function fetchViewCounts(apiKey, videoIds) {
  if (!videoIds || videoIds.length === 0) return {};
  const ids = videoIds.filter(Boolean).slice(0, 50);
  if (ids.length === 0) return {};
  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.map(encodeURIComponent).join(',')}&key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const out = {};
    for (const item of data.items || []) {
      out[item.id] = String(item.statistics?.viewCount ?? '0');
    }
    return out;
  } catch (err) {
    console.error(`[YTData] viewCounts error:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Lightweight RSS/Atom feed parser ÔÇö extracts videoId, title, published,
// thumbnail, link, and media:statistics views from a YouTube videos.xml
// feed. Mirrors parseWebSubPush in tubepulse-api/index.js; both workers
// can parse feeds without a heavy XML library.
function parseRSSFeed(xmlText) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRegex.exec(xmlText)) !== null) {
    const e = m[1];
    const videoId = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = e.match(/<title>([^<]+)<\/title>/)?.[1];
    const link = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1]
      || e.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/)?.[1]
      || `https://www.youtube.com/watch?v=${videoId}`;
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1];
    const updated = e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    const thumbMatch = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1] : null;
    const descMatch = e.match(/<media:description>([^<]*)<\/media:description>/);
    const description = descMatch ? descMatch[1] : '';
    const viewsMatch = e.match(/<media:statistics[^>]*views="(\d+)"/);
    const views = viewsMatch ? viewsMatch[1] : '0';

    // Likes / dislikes live in media:community/media:starRating/@_count
    // and @_dislikes (per YouTube's RSS 2.0 extension). The starRating
    // block looks like:
    //   <media:starRating count="123" average="4.5" min="1" max="5"/>
    // while dislikes is a sibling attribute on media:statistics:
    //   <media:statistics views="123" dislikes="4"/>
    // ÔÇö but the historical-and-most-common shape is:
    //   <media:starRating count="123" average="4.5" min="1" max="5"/>
    //   <media:statistics views="123"/>
    // i.e. count on starRating = likes, dislikes absent in many feeds.
    // We accept both layouts defensively.
    const likesMatch = e.match(/<media:starRating[^>]*count="(\d+)"/);
    const likes = likesMatch ? likesMatch[1] : null;
    let dislikes = null;
    const dislAttrMatch = e.match(/<media:statistics[^>]*dislikes="(\d+)"/);
    if (dislAttrMatch) dislikes = dislAttrMatch[1];

    if (videoId) {
      entries.push({ videoId, title, link, published, updated, thumbnail, description, views, likes, dislikes });
    }
  }

  const channelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
  const channelName = xmlText.match(/<name>([^<]+)<\/name>/)?.[1];

  return { channelId, channelName, entries };
}

// Fetch and parse the YouTube RSS feed for a channel. Returns
// { channelId, channelName, entries: [{videoId, title, link, published, thumbnail, views, ...}] }
// or null on network/error.
async function fetchChannelRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        // YouTube serves a cookie-consent redirect to EU/UK users without these
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': 'SOCS=CAESEwgDEgk2MTcxNTcyNjAaAmVuIAEaBgiA_LyaBg; CONSENT=YES+cb',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'application/atom+xml,application/xml,text/xml,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.warn(`[RSS] HTTP ${resp.status} for ${channelId}`);
      return null;
    }
    const xml = await resp.text();
    return parseRSSFeed(xml);
  } catch (err) {
    console.error(`[RSS] fetch error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ÔöÇÔöÇÔöÇ WebSub lease renewal (DISABLED ÔÇö PubSubHubbub hub is dead) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Google's pubsubhubbub.appspot.com hub was shut down in 2024.
// WebSub subscriptions can no longer be established or renewed for YouTube.
// The RSS poller (runRssPollCron above) replaces push notifications entirely.
// Keep this function for archival; runLeaseCron is now a no-op.

const HUB_URL = 'https://pubsubhubbub.appspot.com/';  // defunct
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';  // active ÔÇö used by fetchChannelRSS above

async function renewSubscriptions(env, callbackUrl) {
  // No-op: WebSub hub is dead, polling is the active path
  return 0;
}

// ÔöÇÔöÇÔöÇ FCM Push ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const base64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const input = `${headerB64}.${payloadB64}`;

  const pemKey = sa.private_key;
  // The Cloudflare secret manager may store the file with literal "\n"
  // two-character sequences (escape sequences) rather than actual newlines.
  // Convert literal "\n" to real newlines first, then strip headers/whitespace.
  let pemBody = pemKey
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  // Fix base64 padding. Google service account JSON sometimes ships with the
  // wrong number of trailing '=' signs because JSON encoding strips them
  // inconsistently. Body length must be divisible by 4 to decode.
  while (pemBody.length % 4 !== 0) {
    pemBody += '=';
  }

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(input)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${input}.${signatureB64}`;

  const tokenResp = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

async function sendFCMPush(accessToken, projectId, fcmToken, payload) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const notification = payload.notification || {};
  const title = payload.title ?? notification.title ?? 'TubePulse';
  const body = payload.body ?? notification.body ?? '';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: {
          title,
          body,
        },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            channel_id: payload.silent ? 'new-videos-silent' : 'new-videos',
            sound: payload.silent ? null : 'default',
            tag: payload.tag || 'tubepulse',
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`FCM push failed for token ${fcmToken.slice(0, 10)}...: ${resp.status} ${errText}`);
    if (resp.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NotRegistered')) {
      return { sent: false, deadToken: true };
    }
    return { sent: false, deadToken: false };
  }

  return { sent: true, deadToken: false };
}

// ÔöÇÔöÇÔöÇ Job 1: Upcoming events (drain only, every 5 min) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// In v3.1 the upcoming bucket scheme is no longer used. The cron's
// prewarn logic is driven by the global `upcoming:events:list` (see
// runPrewarnCron below), not by per-event 5-min time buckets.
//
// This function remains as a drain: it reads the current 5-min bucket
// and deletes it without firing anything. Stale buckets left over from
// pre-v3.1 deploys are cleared this way on the first tick after
// upgrade, so the old "going live soon" / "is live now!" pushes can
// never fire for events that were scheduled before the upgrade.

async function runUpcomingCron(env, ctx) {
  const bucket = currentUpcomingBucket();
  const entries = await getKV(env.TUBEPULSE_KV, key.upcoming(bucket));

  if (!entries || entries.length === 0) {
    return { drained: 0 };
  }

  console.log(`[Upcoming] Draining ${entries.length} stale bucket entry(ies) at ${bucket}`);
  await env.TUBEPULSE_KV.delete(key.upcoming(bucket));
  return { drained: entries.length };
}

// ÔöÇÔöÇÔöÇ Job 1b: Prewarn (per-device pre-notification before live) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
//
// Iterates the global list of currently-scheduled live events and
// fires a per-device "going live in N minutes/hours/days" push to
// each subscriber whose prewarn window is currently active (within
// 5-min slack of `scheduledFor - prewarnMinutes`).
//
// The prewarn time is per-device: a per-channel override
// (`prewarnMinutes`) takes precedence, otherwise the device's global
// `prewarnMinutes` setting is used, otherwise the default (60 min).
//
// Sent-state is tracked in `upcoming:prewarn:{videoId}:{deviceId}` so
// we don't double-send if the cron runs again within the slack window.
//
// Events older than `scheduledFor + 24h` are pruned from the list and
// their per-device sent keys are cleaned up.

const DEFAULT_PREWARN_MINUTES = 60;
const PREWARN_OPTIONS_MINUTES = [15, 30, 60, 120, 240, 1440]; // 15m, 30m, 1h, 2h, 4h, 1d
const PREWARN_SLACK_MS = 5 * 60 * 1000;
const PREWARN_GRACE_MS = 24 * 60 * 60 * 1000; // 24h after scheduledFor

function prewarnLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return '1 hour';
  if (minutes < 1440) return `${minutes / 60} hours`;
  return '1 day';
}

async function runPrewarnCron(env, ctx) {
  const start = Date.now();
  const events = await getKV(env.TUBEPULSE_KV, key.upcomingEvents()) || [];
  if (events.length === 0) {
    return { checked: 0, fired: 0, pruned: 0 };
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('[Prewarn] FCM token error:', err);
    return { checked: events.length, fired: 0, pruned: 0, error: 'fcm_token' };
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;

  const now = Date.now();
  const stillValid = [];
  let fired = 0;
  let pruned = 0;

  for (const event of events) {
    const scheduledFor = new Date(event.scheduledFor).getTime();
    if (isNaN(scheduledFor)) {
      // Malformed event ÔÇö drop it.
      pruned++;
      continue;
    }

    // Past the grace window ÔÇö remove from the list and clean up sent keys.
    if (now > scheduledFor + PREWARN_GRACE_MS) {
      pruned++;
      const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(event.channelId)) || [];
      for (const deviceId of subs) {
        await env.TUBEPULSE_KV.delete(key.prewarnSent(event.videoId, deviceId));
      }
      continue;
    }

    stillValid.push(event);

    // Past the scheduled time + slack ÔÇö the regular RSS-poll push
    // for the now-live video has already fired. No prewarn needed.
    // Keep the event in the list until the grace window for cleanup.
    if (now > scheduledFor + PREWARN_SLACK_MS) continue;

    const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(event.channelId));
    const channelName = meta?.name || event.channelId;
    const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(event.channelId)) || [];

    for (const deviceId of subs) {
      const sent = await getKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId));
      if (sent !== null) continue; // already sent

      const [profile, settings, override] = await Promise.all([
        getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, event.channelId)),
      ]);
      if (!profile?.fcmToken) continue;

      // Prewarn time: per-channel override > global > default
      const prewarnMinutes = override?.prewarnMinutes
        ?? settings?.prewarnMinutes
        ?? DEFAULT_PREWARN_MINUTES;
      if (!PREWARN_OPTIONS_MINUTES.includes(prewarnMinutes)) {
        // Unknown / invalid value ÔÇö treat as default. Don't write to KV;
        // the user just hasn't set a valid value yet.
      }
      const effectiveMinutes = PREWARN_OPTIONS_MINUTES.includes(prewarnMinutes)
        ? prewarnMinutes
        : DEFAULT_PREWARN_MINUTES;

      const prewarnTime = scheduledFor - effectiveMinutes * 60 * 1000;
      if (prewarnTime > now) {
        // Prewarn time is in the future. Wait for a later tick.
        continue;
      }
      // Prewarn time is now or in the past. Fire the prewarn.
      // The cron's 5-min resolution means the prewarn may fire up to
      // a few minutes late; the body uses the actual remaining time
      // so the user sees accurate information either way.
      //
      // Exception: if the prewarn time is so close to live that the
      // remaining time rounds to 0 minutes, the prewarn is no longer
      // useful ÔÇö the live push is the notification. Mark sent and
      // skip rather than firing a "starting in 0 minutes" push.
      const remainingMs = Math.max(0, scheduledFor - now);
      if (remainingMs < 30000) {
        await putKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId), effectiveMinutes);
        continue;
      }

      // DND / mute checks
      if (override?.muted) {
        await putKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId), effectiveMinutes);
        continue;
      }
      const dndEnabled = settings?.dndEnabled || false;
      const dndStart = settings?.dndStart || '22:00';
      const dndEnd = settings?.dndEnd || '07:00';
      const dndTimezone = settings?.dndTimezone || 'UTC';
      const dndActive = dndEnabled && isDndActive(dndStart, dndEnd, dndTimezone);
      if (dndActive && !override?.dndBypass) {
        // Don't mark as sent ÔÇö DND might end before the event; we'll
        // re-evaluate on the next tick. But cap retries: if we're
        // within 5 min of the event start, give up.
        if (now > scheduledFor - PREWARN_SLACK_MS) {
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId), effectiveMinutes);
        }
        continue;
      }

      // Fire the prewarn. The body shows the actual remaining time
      // (live - now), not the configured prewarnMinutes ÔÇö the cron
      // is 5-min so the prewarn can fire up to a few minutes late,
      // and we want the user to see accurate information.
      const remainingMinutes = Math.round(remainingMs / 60000);
      const notifPayload = {
        notification: {
          title: `${channelName} going live soon`,
          body: `Scheduled event starting in ${prewarnLabel(remainingMinutes)}`,
        },
        data: {
          type: 'prewarn',
          videoId: event.videoId,
          channelId: event.channelId,
          channelName,
          scheduledFor: String(scheduledFor),
          prewarnMinutes: String(effectiveMinutes),
        },
        tag: `video-${event.videoId}`,
      };

      try {
        const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
        if (result.sent) {
          fired++;
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId), effectiveMinutes);
        } else if (result.deadToken) {
          console.log(`[Prewarn] Pruning dead device: ${deviceId}`);
          ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(event.videoId, deviceId), effectiveMinutes);
        }
      } catch (err) {
        console.error(`[Prewarn] FCM push failed for ${deviceId}:`, err?.message || err);
      }
    }
  }

  // Persist the pruned list.
  if (stillValid.length !== events.length) {
    await putKV(env.TUBEPULSE_KV, key.upcomingEvents(), stillValid);
  }

  const elapsed = Date.now() - start;
  console.log(`[Prewarn] ${events.length} event(s) checked, ${fired} prewarn(s) fired, ${pruned} pruned in ${elapsed}ms`);
  return { checked: events.length, fired, pruned };
}

// ÔöÇÔöÇÔöÇ Job 2: Nag cycle (every 15 min) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

// ÔöÇÔöÇÔöÇ Community posts cron ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Polls YouTube's Data API activities.list for each active channel
// once per hour. Captures community posts (text, images, polls) and
// notifies subscribers when a new one is detected. Cost: 1 quota
// unit per channel per hour. With 4 channels and a 10k daily free
// tier budget, this is ~100 units/day or 1% of the free tier.
//
// Community posts are latest-state oriented, not history oriented.
// The first poll stores only the latest post and sends no notifications.
// Later polls compare the fetched latest activity ID against known IDs;
// only a changed latest post is stored and surfaced.

async function runCommunityPostsCron(env, ctx) {
  const start = Date.now();
  const channelsActive = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
  const apiKey = env.YOUTUBE_API_KEY;
  const results = { channelsPolled: 0, newPosts: 0, errors: [] };

  for (const channelId of channelsActive) {
    try {
      results.channelsPolled++;
      const url = `https://www.googleapis.com/youtube/v3/activities?part=snippet&channelId=${encodeURIComponent(channelId)}&maxResults=20&key=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text();
        results.errors.push(`${channelId}: ${resp.status} ${text.slice(0, 100)}`);
        continue;
      }
      const data = await resp.json();
      const items = data.items || [];

      // Filter to community posts (type === 'social') and shape them.
      const posts = items
        .filter((it) => it.snippet?.type === 'social')
        .map((it) => {
          const snip = it.snippet;
          const att = (snip.attachments || [])[0];
          return {
            activityId: it.id,
            publishedAt: snip.publishedAt,
            text: snip.description || '',
            // Thumbnail only for image posts. Polls, quizzes, and plain
            // text posts have no usable single-image URL.
            thumbnail: (att && att.type === 'image' && att.url) ? att.url : null,
            kind: att ? att.type : 'text',
            link: `https://www.youtube.com/channel/${channelId}/community`,
          };
        });

      const latestPost = posts[0] || null;

      // First-run guard: seed latest post state only, without notifying.
      const firstPollAt = await getKV(env.TUBEPULSE_KV, key.firstPollAtPosts(channelId));
      if (!firstPollAt) {
        await putKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId), latestPost ? [latestPost] : []);
        await putKV(env.TUBEPULSE_KV, key.firstPollAtPosts(channelId), new Date().toISOString());
        console.log(`[Posts] first run for ${channelId}: seeded ${latestPost ? 'latest post only' : 'no posts'}, no notifications`);
        continue;
      }

      // Treat the fetched latest activity ID as the watermark. YouTube
      // community post timestamps are not reliable enough to use as the
      // primary ordering signal.
      const prevRecent = await getKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId)) || [];
      const prevIds = new Set(prevRecent.map((p) => p.activityId).filter(Boolean));
      const newPosts = latestPost && !prevIds.has(latestPost.activityId) ? [latestPost] : [];

      if (!latestPost) {
        if (prevRecent.length > 0) {
          await putKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId), []);
          console.log(`[Posts] ${channelId}: no latest post found, cleared cached post state`);
        }
        continue;
      }

      if (prevIds.has(latestPost.activityId)) {
        if (prevRecent.length !== 1 || prevRecent[0]?.activityId !== latestPost.activityId) {
          await putKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId), [latestPost]);
          console.log(`[Posts] ${channelId}: compacted cached post history to latest post`);
        }
        continue;
      }

      if (newPosts.length > 0) {
        // Store only the changed latest post so old community-post
        // history is not dumped into the app feed.
        await putKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId), [latestPost]);
        results.newPosts += 1;
        console.log(`[Posts] ${channelId}: new latest post ${latestPost.activityId}`);

        // Notify subscribers. Per-channel opt-out respected: if a
        // device's channel override has includeCommunityPosts === false,
        // skip that device. The cron reads each subscriber's profile +
        // override and fans out a push notification for the changed
        // latest post.
        const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
        for (const post of newPosts) {
          for (const deviceId of subs) {
            const profile = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));
            if (!profile?.fcmToken) continue;

            // Global + per-channel opt-out check. Per-channel override
            // (true|false) wins; otherwise the global setting applies.
            const override = await getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId));
            const overrideValue = override?.includeCommunityPosts;
            if (overrideValue === false) continue; // explicit channel opt-out
            if (overrideValue !== true) {
              // No override ÔåÆ fall back to global. Skip if global is off.
              const settings = await getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)) || {};
              if (!settings.includeCommunityPosts) continue;
            }

            // Track the post as unwatched for this device so the app
            // shows the blue dot and the server's /seen endpoint can
            // clear it. activityIds are namespaced with "post:" so they
            // don't collide with video IDs in the shared unwatched list.
            const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId)) || {
              unwatched: [],
              nagCount: 0,
            };
            const postKey = `post:${post.activityId}`;
            if (!state.unwatched.includes(postKey)) {
              state.unwatched.push(postKey);
              await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);
            }

            const truncated = post.text.length > 100
              ? post.text.slice(0, 97) + '...'
              : post.text;
            const postLabel = post.kind === 'poll' ? 'posted a poll'
              : post.kind === 'image' ? 'posted an image'
              : 'posted';

            const notifPayload = {
              notification: {
                title: `@${(profile.channelHandle || channelId)} ${postLabel}`,
                body: truncated || '(no text)',
              },
              data: {
                type: 'post',
                channelId,
                activityId: post.activityId,
                postKind: post.kind,
              },
              token: profile.fcmToken,
            };

            const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
            const projectId = sa.project_id;
            try {
              const accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
              const sendResult = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
              if (sendResult.deadToken) {
                console.log(`[Posts] Pruning dead device: ${deviceId}`);
                ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
              }
            } catch (err) {
              console.error(`[Posts] FCM push failed for ${deviceId}:`, err?.message || err);
            }
          }
        }
      }
    } catch (err) {
      results.errors.push(`${channelId}: ${err.message || err}`);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[Posts] Cron done: ${results.channelsPolled} channels, ${results.newPosts} new posts, ${results.errors.length} errors, ${elapsed}ms`);
  return results;
}

async function runNagCron(env, ctx) {
  const bucket = currentNagBucket();
  const entries = await getKV(env.TUBEPULSE_KV, key.nag(bucket));

  if (!entries || entries.length === 0) {
    console.log(`[Nag] No nags at ${bucket}`);
    return { fired: 0 };
  }

  console.log(`[Nag] ${entries.length} nag(s) at ${bucket}`);

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('[Nag] FCM token error:', err);
    return { fired: 0 };
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  let fired = 0;
  const deadTokens = [];

  for (const entry of entries) {
    const { deviceId, channelId, videoIds: scheduledVideoIds } = entry;

    // Re-check state - videos may have been marked seen since bucket was written
    const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
    const stillUnwatched = scheduledVideoIds.filter(
      (id) => state?.unwatched?.includes(id)
    );

    if (stillUnwatched.length === 0) {
      continue; // All seen - skip
    }

    // Read device profile + settings + override
    const [profile, settings, override] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId)),
    ]);

    if (!profile?.fcmToken) continue;

    const effective = {
      mode: override?.mode || settings?.mode || 'chill',
      nagInterval: override?.nagInterval || settings?.nagInterval || 15,
      dndEnabled: settings?.dndEnabled || false,
      dndStart: settings?.dndStart || '22:00',
      dndEnd: settings?.dndEnd || '07:00',
      dndTimezone: settings?.dndTimezone || 'UTC',
      dndBypass: override?.dndBypass || false,
      muted: override?.muted || false,
      tapAction: settings?.tapAction || 'video',
    };

    if (effective.muted) continue;

    // DND check
    const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
    if (dndActive && !effective.dndBypass) {
      // Re-schedule nag for next bucket after DND ends
      // (approximation: just try again in 15 min)
      const nextBucket = nagBucket(Date.now() + 15 * 60 * 1000);
      const nextData = await getKV(env.TUBEPULSE_KV, key.nag(nextBucket)) || [];
      const exists = nextData.some((e) => e.deviceId === deviceId && e.channelId === channelId);
      if (!exists) {
        nextData.push({ deviceId, channelId, videoIds: stillUnwatched });
        await putKV(env.TUBEPULSE_KV, key.nag(nextBucket), nextData);
      }
      continue;
    }

    // Get channel info for notification text
    const [meta, recent] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)),
    ]);

    const channelName = meta?.name || channelId;

    // Build notification
    let notifPayload;
    if (stillUnwatched.length === 1) {
      const videoId = stillUnwatched[0];
      const video = recent?.find((v) => v.videoId === videoId);
      notifPayload = {
        title: `${channelName} - reminder`,
        body: video?.title || 'Unwatched video',
        data: {
          videoId,
          channelId,
          channelName,
          videoLink: video?.link || `https://www.youtube.com/watch?v=${videoId}`,
          type: 'nag',
        },
        tag: `video-${videoId}`,
      };
    } else {
      notifPayload = {
        title: `${channelName} - ${stillUnwatched.length} unwatched`,
        body: 'You have videos waiting',
        data: {
          type: 'batch',
          count: String(stillUnwatched.length),
          channelId,
        },
        tag: 'tubepulse-batch',
      };
    }

    const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);

    if (result.sent) {
      fired++;
      // Update state
      state.lastNagAt = Date.now();
      state.nagCount = (state.nagCount || 0) + 1;
      await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);

      // Schedule next nag
      const nagIntervalMs = effective.nagInterval * 60 * 1000;
      const nextNagTime = effective.mode === 'chill'
        ? Date.now() + 4 * 60 * 60 * 1000
        : Date.now() + nagIntervalMs;

      const nb = nagBucket(nextNagTime);
      const nextBucketData = await getKV(env.TUBEPULSE_KV, key.nag(nb)) || [];
      const exists = nextBucketData.some((e) => e.deviceId === deviceId && e.channelId === channelId);
      if (!exists) {
        nextBucketData.push({ deviceId, channelId, videoIds: stillUnwatched });
        await putKV(env.TUBEPULSE_KV, key.nag(nb), nextBucketData);
      }
    } else if (result.deadToken) {
      deadTokens.push(deviceId);
    }
  }

  // Clean up dead tokens ÔÇö full device cleanup so the KV state stays
  // consistent (don't leave orphaned profile/settings/state/override keys
  // for devices the FCM server has confirmed are gone).
  for (const deviceId of deadTokens) {
    console.log(`[Nag] Pruning dead device: ${deviceId}`);
    ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
  }

  // Clear the processed bucket
  await env.TUBEPULSE_KV.delete(key.nag(bucket));

  return { fired };
}

// ÔöÇÔöÇÔöÇ Job 2.5: YouTube RSS polling (every 5 min) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Active new-video detection path. Uses the public YouTube RSS feed
// (https://www.youtube.com/feeds/videos.xml?channel_id=...) which costs
// zero YouTube Data API quota. Each feed entry carries videoId, title,
// publishedAt, thumbnail, link, and view count (from media:statistics).
//
// The YouTube Data API is now used ONLY at subscribe time by the API
// worker (handle ÔåÆ channelId resolve, channel meta + avatar fetch).
// After subscribe, the channel meta is cached in KV and never re-fetched
// by the cron ÔÇö RSS is enough for the recent list.
//
// What this means for the YouTube Data API quota budget:
//   - 1 unit per subscribe (one-time, only when a new channel is added)
//   - 0 units per 5-min tick
//   - Previously: ~2 units per channel per 5-min tick (playlistItems + videos.statistics)
//   - At 50 channels: ~28,800 units/day ÔåÆ 0 units/day
//
// What this means for Cloudflare KV budget:
//   - Reads per channel per tick: 1 (recent) + 1 (meta, only if changed) Ôëê 1-2
//   - Writes per channel per tick: 0 if nothing changed, 1 if recent changed
//   - With 50 channels: 50-100 writes/day, well under the 1,000/day free tier

async function runRssPollCron(env, ctx) {
  const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
  if (active.length === 0) {
    return { channels: 0, newVideos: 0 };
  }

  console.log(`[YTData] Polling ${active.length} channel(s) via RSS`);

  let totalNew = 0;
  let errors = 0;

  for (const channelId of active) {
    try {
      // 1. Fetch the channel's RSS feed. Each entry already carries
      // videoId, title, publishedAt, thumbnail, link, AND views.
      const feed = await fetchChannelRSS(channelId);
      if (!feed) {
        errors++;
        if (errors > 5) {
          console.error('[YTData] Multiple RSS errors ÔÇö aborting poll');
          break;
        }
        continue;
      }
      if (feed.entries.length === 0) continue;

      // Normalise entries to the shape the rest of the system expects.
      // We carry views + likes + dislikes through to the per-video refresh
      // and the new-video enrichment, so the same RSS response fills
      // every engagement metric in one pass.
      const uploads = feed.entries.map((e) => ({
        videoId: e.videoId,
        title: e.title,
        published: e.published,
        thumbnail: e.thumbnail,
        link: e.link,
        channelTitle: feed.channelName,
        views: e.views,
        likes: e.likes,
        dislikes: e.dislikes,
      }));

      // 2. Read existing recent list to find new videos
      const prevRecent = await getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)) || [];
      const prevVideoIds = new Set(prevRecent.map((v) => v.videoId));
      const newVideos = uploads.filter((v) => !prevVideoIds.has(v.videoId));

      // 3. Hourly view-count refresh for the LATEST video only.
      //
      // The RSS response gives us fresh view counts for all 15 videos
      // for free, but we don't want to write every tick ÔÇö that would
      // burn ~576 writes/day for 4 channels. So:
      //
      //   - Only the latest video's view count is considered for writes
      //   - The "latest video" is the first entry in prevRecent (newest first)
      //   - We only consider refreshing on the top of a new hour
      //   - We only write if the count changed by more than 5% from the
      //     last value we stored (so small tick-by-tick fluctuations
      //     don't trigger writes)
      //   - View counts on prior videos (index 1-14) are read into the
      //     local `refreshedPrev` but NOT persisted ÔÇö they're ignored
      //     for the write decision and stay at their last stored value
      //   - When a new video is detected, we still write the new list
      //     (which includes the new video's view count) ÔÇö that path
      //     is handled below
      //
      // Net effect: cron writes drop from ~576/day to ~96/day for 4
      // channels (at most one hourly write per channel, often zero
      // when the 5% threshold isn't met).
      const rssByVideoId = new Map(uploads.map((u) => [u.videoId, u]));
      const refreshedPrev = prevRecent.map((v) => v); // start with originals
      let recentChanged = false;

      // One-time backfill: for any video that doesn't have a `likes`
      // or `dislikes` field, populate it from the current RSS data.
      // This catches videos that were stored before v3.1.1 deployed
      // and never had engagement metrics. Once populated, the field
      // is present and this block becomes a no-op.
      //
      // Only writes if at least one video was actually backfilled ÔÇö
      // keeps the write cost at one transition write per channel,
      // not one write per tick. After the first run, no more writes
      // are generated by this block.
      let backfilledAny = false;
      for (let i = 0; i < refreshedPrev.length; i++) {
        const v = refreshedPrev[i];
        const rss = rssByVideoId.get(v.videoId);
        if (!rss) continue;
        const needsLikes = v.likes === undefined || v.likes === null;
        const needsDislikes = v.dislikes === undefined || v.dislikes === null;
        if (!needsLikes && !needsDislikes) continue;
        refreshedPrev[i] = {
          ...v,
          likes: rss.likes != null ? String(rss.likes) : '0',
          dislikes: rss.dislikes != null ? String(rss.dislikes) : '0',
        };
        backfilledAny = true;
      }
      if (backfilledAny) {
        recentChanged = true;
        console.log(`[YTData] ${channelId}: backfilled likes/dislikes for stored videos`);
      }

      const latest = prevRecent[0];
      const latestFromRss = latest && rssByVideoId.get(latest.videoId);
      const currentHour = Math.floor(Date.now() / 3600000);

      if (latest && latestFromRss) {
        const oldViews = parseInt(latest.views || '0', 10);
        const newViews = parseInt(latestFromRss.views || '0', 10);
        // Only consider refreshing on the top of a new hour, AND only
        // if the count changed by more than 5% (or it's a new video
        // we haven't counted yet).
        const viewsChanged = (
          !isNaN(oldViews) && !isNaN(newViews) &&
          currentHour !== latest.viewsLastCheckedHour &&
          (oldViews === 0 || Math.abs(newViews - oldViews) / Math.max(oldViews, 1) > 0.05)
        );

        // Likes / dislikes: also refresh hourly on the latest video.
        // Use a simple "any change" rule ÔÇö likes/dislikes are cheap to
        // store and useful to see updated.
        const oldLikes = latest.likes;
        const newLikes = latestFromRss.likes != null ? String(latestFromRss.likes) : null;
        const oldDislikes = latest.dislikes;
        const newDislikes = latestFromRss.dislikes != null ? String(latestFromRss.dislikes) : null;
        const likesChanged = (
          currentHour !== latest.viewsLastCheckedHour &&
          ((newLikes != null && newLikes !== oldLikes) || (newDislikes != null && newDislikes !== oldDislikes))
        );

        if (viewsChanged) {
          refreshedPrev[0] = { ...latest, views: String(newViews), viewsLastCheckedHour: currentHour };
          recentChanged = true;
        } else if (latest.viewsLastCheckedHour === undefined) {
          // First time we see this video ÔÇö record the hour so we don't
          // re-check on the next tick. Don't write yet; wait for an
          // actual change.
          refreshedPrev[0] = { ...latest, viewsLastCheckedHour: currentHour };
          recentChanged = true;
        }

        if (likesChanged) {
          // Apply likes/dislikes to the latest video (merged on top of
          // any views change we just made).
          refreshedPrev[0] = {
            ...refreshedPrev[0],
            likes: newLikes != null ? newLikes : (latest.likes || '0'),
            dislikes: newDislikes != null ? newDislikes : (latest.dislikes || '0'),
            likesLastCheckedHour: currentHour,
          };
          recentChanged = true;
        }
      }

      if (newVideos.length === 0) {
        if (recentChanged) {
          await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), refreshedPrev);
        }
        continue;
      }

      // 4. New videos detected ÔÇö build the updated recent list
      // The newest video's view count is fresh from this RSS response.
      // Prior videos keep their last-stored view counts (we don't bother
      // refreshing them in this path either, even on new-video ticks,
      // because the new video is the one that matters for the user).
      //
      // Likes / dislikes: also pulled from RSS for new videos, and for
      // the latest existing video when they change (refreshed hourly on
      // the same cadence as views). Older videos keep their last stored
      // counts.
      const rssByVideoIdLatest = new Map(uploads.map((u) => [u.videoId, u]));
      const enrichedNew = newVideos.map((v) => {
        const rss = rssByVideoIdLatest.get(v.videoId) || v;
        return {
          videoId: v.videoId,
          title: v.title,
          publishedAt: v.published,
          thumbnail: v.thumbnail,
          type: classifyVideo(v),
          link: v.link,
          views: v.views || '0',
          likes: rss.likes != null ? String(rss.likes) : '0',
          dislikes: rss.dislikes != null ? String(rss.dislikes) : '0',
        };
      });

      const updatedRecent = [...enrichedNew, ...refreshedPrev].slice(0, 15);
      await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), updatedRecent);

      // 5. Update channel meta (name, lastVideoId) ÔÇö only if changed
      const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)) || {};
      let metaChanged = false;
      if (!meta.name && feed.channelName) {
        meta.name = feed.channelName;
        metaChanged = true;
      }
      if (meta.lastVideoId !== newVideos[0].videoId) {
        meta.lastVideoId = newVideos[0].videoId;
        metaChanged = true;
      }
      if (metaChanged) {
        await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta);
      }

      // 6. Get subscribers
      const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
      if (subs.length === 0) {
        totalNew += newVideos.length;
        continue;
      }

      // 7. Get FCM access token once
      let accessToken;
      try {
        accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
      } catch (err) {
        console.error(`[YTData] FCM token error:`, err);
        totalNew += newVideos.length;
        continue;
      }
      const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      const projectId = sa.project_id;
      const deadDevices = []; // collected during the per-device fan-out, cleaned at the end

      for (const deviceId of subs) {
        const [profile, settings, override] = await Promise.all([
          getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
          getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
          getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId)),
        ]);

        if (!profile?.fcmToken) continue;
        if (override?.muted) continue;

        const effective = {
          mode: override?.mode || settings?.mode || 'chill',
          nagInterval: override?.nagInterval || settings?.nagInterval || 15,
          dndEnabled: settings?.dndEnabled || false,
          dndStart: settings?.dndStart || '22:00',
          dndEnd: settings?.dndEnd || '07:00',
          dndTimezone: settings?.dndTimezone || 'UTC',
          dndBypass: override?.dndBypass || false,
          tapAction: settings?.tapAction || 'video',
        };

        // Per-device per-channel state
        const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId)) || {
          unwatched: [],
          lastNagAt: null,
          nagCount: 0,
        };

        let shouldNotify = true;
        for (const video of newVideos) {
          if (!state.unwatched.includes(video.videoId)) {
            state.unwatched.push(video.videoId);
          }

          if (video.type === 'live_scheduled') {
            // v3.1: no bucket writes. Prewarn is fired by
            // runPrewarnCron at the user's preferred prewarn time
            // (driven by the upcoming:events:list, not by a
            // hardcoded 30-min bucket). At live time the video is
            // re-detected as type 'live' below and added to
            // channelRecent as a normal new video ÔÇö no separate
            // "live now!" push.
            const publishedTime = new Date(video.publishedAt).getTime();

            // Append to the global scheduled-events list so
            // runPrewarnCron can iterate and fire per-device
            // prewarns. Idempotent ÔÇö skip if this videoId is
            // already in the list.
            const events = await getKV(env.TUBEPULSE_KV, key.upcomingEvents()) || [];
            if (!events.some((e) => e.videoId === video.videoId)) {
              events.push({
                channelId,
                videoId: video.videoId,
                scheduledFor: publishedTime,
                addedAt: Date.now(),
              });
              await putKV(env.TUBEPULSE_KV, key.upcomingEvents(), events);
            }
            continue;
          }

          const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
          const isLivestream = video.type === 'live';
          const bypassesDnd = effective.dndBypass || isLivestream;
          if (dndActive && !bypassesDnd) {
            shouldNotify = false;
          }
        }

        // Save updated state
        await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);

        // Send FCM
        const notifyEntries = newVideos.filter((v) => v.type !== 'live_scheduled' && shouldNotify);
        if (notifyEntries.length > 0) {
          let notifPayload;
          const channelName = meta.name || channelId;
          if (notifyEntries.length === 1) {
            const v = notifyEntries[0];
            notifPayload = {
              title: `${channelName} uploaded`,
              body: v.title,
              data: {
                videoId: v.videoId,
                channelId,
                channelName,
                videoLink: v.link,
                type: v.type,
              },
              tag: `video-${v.videoId}`,
            };
          } else {
            notifPayload = {
              title: `${channelName} - ${notifyEntries.length} new videos`,
              body: notifyEntries.map((v) => v.title).join('\n'),
              data: {
                type: 'batch',
                count: String(notifyEntries.length),
                channelId,
              },
              tag: 'tubepulse-batch',
            };
          }
          const pushResult = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
          if (pushResult.deadToken) {
            deadDevices.push(deviceId);
          }
        }

        // Schedule nag
        if (state.unwatched.length > 0 && shouldNotify) {
          const nagIntervalMs = effective.nagInterval * 60 * 1000;
          const nextNagTime = effective.mode === 'chill'
            ? Date.now() + 4 * 60 * 60 * 1000
            : Date.now() + nagIntervalMs;
          const bucket = nagBucket(nextNagTime);
          const bucketData = await getKV(env.TUBEPULSE_KV, key.nag(bucket)) || [];
          const exists = bucketData.some((e) => e.deviceId === deviceId && e.channelId === channelId);
          if (!exists) {
            bucketData.push({ deviceId, channelId, videoIds: [...state.unwatched] });
            await putKV(env.TUBEPULSE_KV, key.nag(bucket), bucketData);
          }
        }
      }

      // Clean up any dead devices we collected during this channel's
      // fan-out. Deduped (a device subscribed to multiple channels will
      // only be cleaned once even if it appears in several iterations).
      for (const deviceId of [...new Set(deadDevices)]) {
        console.log(`[YTData] Pruning dead device: ${deviceId}`);
        ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
      }

      totalNew += newVideos.length;
    } catch (err) {
      console.error(`[YTData] Error processing ${channelId}:`, err.message);
    }
  }

  return { channels: active.length, newVideos: totalNew, errors };
}

// ÔöÇÔöÇÔöÇ Job 3: Lease renewal (every 6 hours) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

async function runLeaseCron(env) {
  const callbackUrl = 'https://tubepulse-api.jimothyoakley55.workers.dev/websub';
  const renewed = await renewSubscriptions(env, callbackUrl);
  return { renewed };
}

// ÔöÇÔöÇÔöÇ Main handler ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export default {
  async scheduled(event, env, ctx) {
    const startTime = Date.now();
    const now = new Date();
    const mins = now.getUTCMinutes();
    const hours = now.getUTCHours();

    console.log(`[Cron] Tick at ${now.toISOString()} (minute=${mins})`);

    const results = {};

    // Upcoming events: every 5 minutes (minute % 5 === 0)
    if (mins % 5 === 0) {
      results.upcoming = await runUpcomingCron(env, ctx);
    }

    // Prewarn: every 5 minutes (minute % 5 === 0) ÔÇö iterates the
    // scheduled-events list and fires per-device prewarns when each
    // device's window is active.
    if (mins % 5 === 0) {
      results.prewarn = await runPrewarnCron(env, ctx);
    }

    // RSS poll: every 5 minutes (minute % 5 === 0) ÔÇö fallback for WebSub
    if (mins % 5 === 0) {
      results.rss = await runRssPollCron(env, ctx);
    }

    // Nag cycle: every 15 minutes (minute % 15 === 0)
    if (mins % 15 === 0) {
      results.nag = await runNagCron(env, ctx);
    }

    // Community posts: every hour (minute === 0)
    if (mins === 0) {
      results.posts = await runCommunityPostsCron(env, ctx);
    }

    // Lease renewal: every 6 hours (minute === 0 && hour % 6 === 0)
    if (mins === 0 && hours % 6 === 0) {
      results.lease = await runLeaseCron(env);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Cron] Done in ${elapsed}ms. Results:`, JSON.stringify(results));
  },
};