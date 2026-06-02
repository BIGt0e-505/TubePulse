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

// ─── Key builders (must match API worker) ────────────────────────────────

const key = {
  channelMeta:      (channelId) => `channel:${channelId}:meta`,
  channelSubs:      (channelId) => `channel:${channelId}:subscribers`,
  channelWebsub:    (channelId) => `channel:${channelId}:websub`,
  channelRecent:    (channelId) => `channel:${channelId}:recent`,
  deviceProfile:    (deviceId)  => `device:${deviceId}:profile`,
  deviceSettings:   (deviceId)  => `device:${deviceId}:settings`,
  deviceOverride:   (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState:      (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  upcoming:         (bucket)    => `upcoming:${bucket}`,
  nag:              (bucket)    => `nag:${bucket}`,
  channelsActive:   ()          => `channels:active`,
};

async function getKV(kv, k) { return await kv.get(k, 'json'); }
async function putKV(kv, k, value) { await kv.put(k, JSON.stringify(value)); }

// ─── DND logic ──────────────────────────────────────────────────────────

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

// ─── Time bucket helpers ────────────────────────────────────────────────

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
  // Future-dated → live_scheduled (premieres / scheduled livestreams)
  if (publishedTime > now + 5 * 60 * 1000) return 'live_scheduled';
  const title = (entry.title || '').toLowerCase();
  if (title.startsWith('🔴') || title.includes(' live')) return 'live';
  return 'video';
}

// ─── YouTube Data API helpers (RSS feeds are 404 as of 2024-2025) ──────
// PubSubHubbub (WebSub) hub was also shut down by Google.
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

// ─── WebSub lease renewal (DISABLED — PubSubHubbub hub is dead) ───────
// Google's pubsubhubbub.appspot.com hub was shut down in 2024.
// WebSub subscriptions can no longer be established or renewed for YouTube.
// The YTData poller replaces push notifications entirely.
// Keep this function for archival; runLeaseCron is now a no-op.

const HUB_URL = 'https://pubsubhubbub.appspot.com/';  // defunct
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';  // also 404

async function renewSubscriptions(env, callbackUrl) {
  // No-op: WebSub hub is dead, polling is the active path
  return 0;
}

// ─── FCM Push ───────────────────────────────────────────────────────────

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
          title: payload.title,
          body: payload.body,
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

// ─── Job 1: Upcoming events (every 5 min) ───────────────────────────────

async function runUpcomingCron(env) {
  const bucket = currentUpcomingBucket();
  const entries = await getKV(env.TUBEPULSE_KV, key.upcoming(bucket));

  if (!entries || entries.length === 0) {
    console.log(`[Upcoming] No events at ${bucket}`);
    return { fired: 0 };
  }

  console.log(`[Upcoming] ${entries.length} event(s) at ${bucket}`);

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('[Upcoming] FCM token error:', err);
    return { fired: 0 };
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  let fired = 0;

  for (const entry of entries) {
    // Get channel meta
    const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(entry.channelId));
    const channelName = meta?.name || entry.channelId;

    // Get subscribers for this channel
    const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];

    for (const deviceId of subs) {
      const [profile, settings, override] = await Promise.all([
        getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, entry.channelId)),
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
      };

      if (effective.muted) continue;

      const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
      if (dndActive && !effective.dndBypass) continue;

      let title, body;
      if (entry.headsUp) {
        title = `${channelName} going live soon`;
        body = 'Scheduled event starting in 30 minutes';
      } else {
        title = `${channelName} is live now!`;
        body = 'The scheduled event has started';
      }

      const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, {
        title,
        body,
        data: {
          videoId: entry.videoId,
          channelId: entry.channelId,
          channelName,
          type: entry.headsUp ? 'upcoming' : 'new_video',
        },
        tag: `video-${entry.videoId}`,
      });

      if (result.sent) {
        fired++;
      } else if (result.deadToken) {
        // Clean up dead device
        await env.TUBEPULSE_KV.delete(key.deviceProfile(deviceId));
        const currentSubs = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];
        await putKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId), currentSubs.filter((id) => id !== deviceId));
      }
    }

    // If this was the "live now" event (headsUp=false), also move video into nag system
    if (!entry.headsUp) {
      const subs2 = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];
      for (const deviceId of subs2) {
        const [settings2, override2] = await Promise.all([
          getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
          getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, entry.channelId)),
        ]);

        const mode = override2?.mode || settings2?.mode || 'chill';
        const nagInterval = override2?.nagInterval || settings2?.nagInterval || 15;
        const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, entry.channelId)) || {
          unwatched: [],
          lastNagAt: null,
          nagCount: 0,
        };

        // Ensure video is in unwatched
        if (!state.unwatched.includes(entry.videoId)) {
          state.unwatched.push(entry.videoId);
        }
        state.lastNagAt = Date.now();
        await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, entry.channelId), state);

        // Schedule next nag
        const nextNagTime = mode === 'chill'
          ? Date.now() + 4 * 60 * 60 * 1000
          : Date.now() + nagInterval * 60 * 1000;

        const nb = nagBucket(nextNagTime);
        const bucketData = await getKV(env.TUBEPULSE_KV, key.nag(nb)) || [];
        const exists = bucketData.some((e) => e.deviceId === deviceId && e.channelId === entry.channelId);
        if (!exists) {
          bucketData.push({
            deviceId,
            channelId: entry.channelId,
            videoIds: [...state.unwatched],
          });
          await putKV(env.TUBEPULSE_KV, key.nag(nb), bucketData);
        }
      }
    }
  }

  // Clear the processed bucket
  await env.TUBEPULSE_KV.delete(key.upcoming(bucket));

  return { fired };
}

// ─── Job 2: Nag cycle (every 15 min) ────────────────────────────────────

async function runNagCron(env) {
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

  // Clean up dead tokens
  for (const deviceId of deadTokens) {
    console.log(`[Nag] Pruning dead device: ${deviceId}`);
    await env.TUBEPULSE_KV.delete(key.deviceProfile(deviceId));
    // Remove from all subscriber lists - we don't know which channels,
    // but the next push to any channel they were on will skip them
    // A weekly consistency check should fully clean up
  }

  // Clear the processed bucket
  await env.TUBEPULSE_KV.delete(key.nag(bucket));

  return { fired };
}

// ─── Job 2.5: YouTube Data API polling (every 5 min) ────────────────
// WebSub push was the preferred path, but Google's pubsubhubbub.appspot.com
// hub was shut down (2024), and YouTube's public RSS feeds now 404 (2024-2025).
// Polling the YouTube Data API is the only reliable way to detect new uploads.
// The notification path is identical to what a WebSub push would have done —
// the same FCM + nag scheduling runs whether a video was detected via push
// or poll. This means the rest of the system doesn't notice the swap.
//
// Cost: 1 unit per channels.list (one-time, then playlistId cached in meta)
//       + 1 unit per playlistItems.list. ~16,000 polls/day for 50 channels
//       with cached playlist IDs (under the 10,000 default quota on fresh).

async function runRssPollCron(env) {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('[YTData] YOUTUBE_API_KEY not set — cannot poll');
    return { channels: 0, newVideos: 0, error: 'no_api_key' };
  }

  const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
  if (active.length === 0) {
    return { channels: 0, newVideos: 0 };
  }

  console.log(`[YTData] Polling ${active.length} channel(s)`);

  let totalNew = 0;
  let quotaErrors = 0;

  for (const channelId of active) {
    try {
      // 1. Ensure we have the uploads playlist ID (cached in meta)
      const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)) || {};
      let playlistId = meta.uploadsPlaylistId;
      if (!playlistId) {
        playlistId = await getUploadsPlaylistId(apiKey, channelId);
        if (playlistId) {
          meta.uploadsPlaylistId = playlistId;
          await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta);
        } else {
          console.warn(`[YTData] No uploads playlist for ${channelId} — skipping`);
          continue;
        }
      }

      // 2. Fetch the latest uploads (top 10)
      const uploads = await getRecentUploadsFromPlaylist(apiKey, playlistId, 10);
      if (!uploads) {
        quotaErrors++;
        if (quotaErrors > 3) {
          console.error('[YTData] Multiple quota/connection errors — aborting poll');
          break;
        }
        continue;
      }
      if (uploads.length === 0) continue;

      // 3. Find new videos (not already in `recent`)
      const prevRecent = await getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)) || [];
      const prevVideoIds = new Set(prevRecent.map((v) => v.videoId));
      const newVideos = uploads.filter((v) => !prevVideoIds.has(v.videoId));
      if (newVideos.length === 0) {
        // No new videos this tick, but refresh view counts on the existing
        // recent list so the views don't go stale. Cheap: 1 quota unit per
        // channel per 5-min tick.
        const recentVideoIds = prevRecent.map((v) => v.videoId).filter(Boolean);
        if (recentVideoIds.length > 0) {
          const viewCounts = await fetchViewCounts(apiKey, recentVideoIds);
          if (viewCounts) {
            let recentChanged = false;
            const refreshedRecent = prevRecent.map((v) => {
              const newViews = viewCounts[v.videoId];
              if (newViews !== undefined && newViews !== v.views) {
                recentChanged = true;
                return { ...v, views: newViews };
              }
              return v;
            });
            if (recentChanged) {
              await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), refreshedRecent);
            }
          }
        }
        continue;
      }

      // 4. Update channel recent (newest first, max 15)
      // Fetch view counts in a single batched call for the 15 most recent.
      const allVideoIds = [...newVideos, ...prevRecent].slice(0, 15).map((v) => v.videoId);
      const viewCounts = await fetchViewCounts(apiKey, allVideoIds) || {};

      const enrichedNew = newVideos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        publishedAt: v.published,
        thumbnail: v.thumbnail,
        type: classifyVideo(v),
        link: v.link,
        views: viewCounts[v.videoId] || '0',
      }));

      // Re-stamp view counts on existing recent entries so they stay fresh.
      const refreshedPrev = prevRecent.map((v) => {
        const newViews = viewCounts[v.videoId];
        return newViews !== undefined ? { ...v, views: newViews } : v;
      });

      const updatedRecent = [...enrichedNew, ...refreshedPrev].slice(0, 15);
      await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), updatedRecent);

      // 5. Update channel meta
      if (!meta.name && uploads[0].channelTitle) meta.name = uploads[0].channelTitle;
      meta.lastVideoId = newVideos[0].videoId;
      if (playlistId) meta.uploadsPlaylistId = playlistId;
      await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta);

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
            // Schedule upcoming bucket entries
            const publishedTime = new Date(video.publishedAt).getTime();
            const headsUpTime = publishedTime - 30 * 60 * 1000;
            if (headsUpTime > Date.now()) {
              const bucket = upcomingBucket(new Date(headsUpTime).toISOString());
              const bucketData = await getKV(env.TUBEPULSE_KV, key.upcoming(bucket)) || [];
              bucketData.push({
                channelId,
                videoId: video.videoId,
                type: 'live_scheduled',
                scheduledFor: publishedTime,
                headsUp: true,
              });
              await putKV(env.TUBEPULSE_KV, key.upcoming(bucket), bucketData);
            }
            const liveBucket = upcomingBucket(new Date(video.publishedAt).toISOString());
            const liveBucketData = await getKV(env.TUBEPULSE_KV, key.upcoming(liveBucket)) || [];
            liveBucketData.push({
              channelId,
              videoId: video.videoId,
              type: 'live_scheduled',
              scheduledFor: publishedTime,
              headsUp: false,
            });
            await putKV(env.TUBEPULSE_KV, key.upcoming(liveBucket), liveBucketData);
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
          await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
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

      totalNew += newVideos.length;
    } catch (err) {
      console.error(`[YTData] Error processing ${channelId}:`, err.message);
    }
  }

  return { channels: active.length, newVideos: totalNew, quotaErrors };
}

// ─── Job 3: Lease renewal (every 6 hours) ──────────────────────────────

async function runLeaseCron(env) {
  const callbackUrl = 'https://tubepulse-api.jimothyoakley55.workers.dev/websub';
  const renewed = await renewSubscriptions(env, callbackUrl);
  return { renewed };
}

// ─── Main handler ───────────────────────────────────────────────────────

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
      results.upcoming = await runUpcomingCron(env);
    }

    // RSS poll: every 5 minutes (minute % 5 === 0) — fallback for WebSub
    if (mins % 5 === 0) {
      results.rss = await runRssPollCron(env);
    }

    // Nag cycle: every 15 minutes (minute % 15 === 0)
    if (mins % 15 === 0) {
      results.nag = await runNagCron(env);
    }

    // Lease renewal: every 6 hours (minute === 0 && hour % 6 === 0)
    if (mins === 0 && hours % 6 === 0) {
      results.lease = await runLeaseCron(env);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Cron] Done in ${elapsed}ms. Results:`, JSON.stringify(results));
  },
};