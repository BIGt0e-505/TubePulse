/**
 * TubePulse Cron Worker
 *
 * Runs every 2 minutes via Cloudflare Cron Trigger.
 * 1. Lists all registered devices from KV
 * 2. Deduplicates channel IDs across all devices
 * 3. Fetches YouTube RSS for each channel
 * 4. Detects new videos by comparing against stored state
 * 5. Sends FCM push notifications to devices that track the channel
 * 6. Updates KV state (channel meta, feed, device lastSeen)
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const GENTLE_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── KV key prefixes ────────────────────────────────────────────────────

const KV_PREFIX_DEVICE = 'device:';
const KV_PREFIX_CHANNEL_META = 'channel:';
const KV_PREFIX_CHANNEL_FEED = 'feed:';

// ─── Helpers ────────────────────────────────────────────────────────────

async function getKV(kv, key) {
  return await kv.get(key, 'json');
}

async function putKV(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

// ─── YouTube RSS ────────────────────────────────────────────────────────

async function fetchYouTubeRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(feedUrl, { signal: controller.signal });
    if (!resp.ok) {
      console.error(`RSS fetch failed for ${channelId}: ${resp.status}`);
      return null;
    }

    const xml = await resp.text();
    const result = parser.parse(xml);

    const feed = result.feed;
    if (!feed || !feed.entry) return { channel: null, videos: [] };

    const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

    const channel = {
      name: feed.author?.name || feed.title || '',
      uri: feed.author?.uri || '',
    };

    const videos = entries.map((entry) => {
      const videoId = entry['yt:videoId'];
      const link = entry.link?.['@_href'] || `https://www.youtube.com/watch?v=${videoId}`;
      const mediaGroup = entry['media:group'] || {};
      const thumbnail = mediaGroup['media:thumbnail']?.['@_url'] || null;
      const description = mediaGroup['media:description'] || '';
      const views = mediaGroup['media:community']?.['media:statistics']?.['@_views'] || '0';

      return {
        videoId,
        title: entry.title,
        published: entry.published,
        updated: entry.updated,
        link,
        thumbnail,
        description,
        views,
      };
    });

    return { channel, videos };
  } catch (err) {
    console.error(`RSS fetch error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── FCM Push ───────────────────────────────────────────────────────────

// Get Google OAuth2 access token using service account key
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

  // Base64url encode
  const base64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const input = `${headerB64}.${payloadB64}`;

  // Sign with RSA - WebCrypto API
  const keyData = {
    kty: 'RSA',
    n: null, // Will extract from PEM
    e: 'AQAB',
    d: null,
    p: null,
    q: null,
    dp: null,
    dq: null,
    qi: null,
  };

  // Import the private key from PEM
  const pemKey = sa.private_key;
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(input)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${input}.${signatureB64}`;

  // Exchange JWT for access token
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

// Send FCM push notification via HTTP v1 API
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
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`FCM push failed for token ${fcmToken.slice(0, 10)}...: ${resp.status} ${errText}`);

    // If token is unregistered, return false so caller can prune it
    if (resp.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NotRegistered')) {
      return { sent: false, deadToken: true };
    }
    return { sent: false, deadToken: false };
  }

  return { sent: true, deadToken: false };
}

// ─── DND logic ──────────────────────────────────────────────────────────

function isDndActive(dndStart, dndEnd) {
  const now = new Date();
  const utcOffset = now.getTimezoneOffset(); // We treat times as device-local; cron uses UTC
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}

// ─── Main cron handler ──────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const startTime = Date.now();
    console.log(`[Cron] Starting poll at ${new Date().toISOString()}`);

    // 1. List all device keys
    const deviceKeys = [];
    let cursor = undefined;
    do {
      const list = await env.TUBEPULSE_KV.list({ prefix: KV_PREFIX_DEVICE, cursor });
      for (const key of list.keys) {
        deviceKeys.push(key.name);
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    console.log(`[Cron] Found ${deviceKeys.length} registered devices`);

    if (deviceKeys.length === 0) {
      console.log('[Cron] No devices registered. Done.');
      return;
    }

    // 2. Fetch all device data and collect unique channel IDs
    const devices = [];
    const channelIdSet = new Set();

    for (const key of deviceKeys) {
      const device = await getKV(env.TUBEPULSE_KV, key);
      if (device) {
        devices.push({ key, ...device });
        for (const ch of device.channels || []) {
          if (ch.channelId) channelIdSet.add(ch.channelId);
        }
      }
    }

    const channelIds = [...channelIdSet];
    console.log(`[Cron] Tracking ${channelIds.length} unique channels across ${devices.length} devices`);

    // 3. Fetch RSS for each channel and detect new videos
    const channelUpdates = {};

    for (const channelId of channelIds) {
      const rssResult = await fetchYouTubeRSS(channelId);
      if (!rssResult || !rssResult.channel) {
        console.warn(`[Cron] No RSS data for ${channelId}`);
        continue;
      }

      const prevMeta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId);

      const meta = {
        name: rssResult.channel.name,
        avatar: prevMeta?.avatar || null, // RSS doesn't include avatar; preserve from previous fetch
        lastVideoId: rssResult.channel.videos?.[0]?.videoId || prevMeta?.lastVideoId || null,
        lastVideoTitle: rssResult.channel.videos?.[0]?.title || null,
        lastVideoPublished: rssResult.channel.videos?.[0]?.published || null,
        lastChecked: new Date().toISOString(),
      };

      // Save feed data (top 5 videos)
      const feed = {
        videos: (rssResult.videos || []).slice(0, 5),
        lastFetched: new Date().toISOString(),
      };

      await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId, meta);
      await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId, feed);

      // Detect new video
      const newVideoId = rssResult.videos?.[0]?.videoId;
      const prevVideoId = prevMeta?.lastVideoId;

      if (newVideoId && newVideoId !== prevVideoId) {
        channelUpdates[channelId] = {
          videoId: newVideoId,
          title: rssResult.videos[0].title,
          link: rssResult.videos[0].link,
          published: rssResult.videos[0].published,
          channelName: meta.name,
          isNew: true,
        };
        console.log(`[Cron] NEW video on ${channelId}: ${newVideoId} — "${rssResult.videos[0].title}"`);
      } else {
        channelUpdates[channelId] = { isNew: false };
      }
    }

    // 4. If no new videos, we're done
    const newChannels = Object.entries(channelUpdates).filter(([_, v]) => v.isNew);
    if (newChannels.length === 0) {
      console.log('[Cron] No new videos. Done.');
      return;
    }

    console.log(`[Cron] ${newChannels.length} channel(s) have new videos`);

    // 5. Get FCM access token
    let accessToken;
    try {
      accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('[Cron] Failed to get FCM access token:', err);
      return;
    }

    // Extract project ID from service account
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = sa.project_id;

    // 6. Push notifications to devices tracking new-video channels
    const deadTokens = [];
    let pushCount = 0;

    for (const device of devices) {
      const fcmToken = device.key.replace(KV_PREFIX_DEVICE, '');
      let deviceUpdated = false;

      for (const ch of device.channels || []) {
        if (!ch.channelId) continue;
        const update = channelUpdates[ch.channelId];
        if (!update || !update.isNew) continue;

        // Check if device has already seen this video
        const handle = ch.handle;
        const seenIds = device.lastSeen?.[handle]?.seenIds || [];
        if (seenIds.includes(update.videoId)) continue;

        // Determine notification mode
        const perChannelEnabled = device.settings?.perChannelNotifications || false;
        const channelOverride = perChannelEnabled ? device.settings?.channelNotifSettings?.[handle] : null;
        const effectiveSettings = channelOverride
          ? { ...device.settings, ...channelOverride }
          : device.settings;
        const mode = effectiveSettings?.notificationMode || 'relentless';

        // Check DND
        const dndEnabled = effectiveSettings?.dndEnabled || false;
        const silent = dndEnabled && isDndActive(
          effectiveSettings?.dndStart || '22:00',
          effectiveSettings?.dndEnd || '07:00'
        );

        // Chill mode logic: notify once, then remind every 4h
        if (mode === 'chill') {
          const gentle = device.lastSeen?.[handle]?.gentleState;
          const now = Date.now();

          if (gentle && gentle.videoId === update.videoId) {
            // Already notified about this one
            if (now - gentle.lastRemindedAt < GENTLE_REMINDER_INTERVAL_MS) {
              continue; // Too soon for a reminder
            }
            // Time for a reminder
          }

          // Update gentle state
          if (!device.lastSeen) device.lastSeen = {};
          if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };
          if (!device.lastSeen[handle].gentleState) {
            device.lastSeen[handle].gentleState = {
              videoId: update.videoId,
              firstNotifiedAt: Date.now(),
              lastRemindedAt: Date.now(),
            };
          } else {
            device.lastSeen[handle].gentleState.lastRemindedAt = Date.now();
          }
          deviceUpdated = true;
        }

        // Relentless mode: always push (no gentle state needed)

        // Send FCM push
        const result = await sendFCMPush(accessToken, projectId, fcmToken, {
          title: `${update.channelName} uploaded`,
          body: update.title,
          data: {
            videoId: update.videoId,
            channelName: update.channelName,
            handle: handle,
            videoLink: update.link,
            type: 'new_video',
          },
          silent,
        });

        if (result.sent) {
          pushCount++;
        } else if (result.deadToken) {
          deadTokens.push(device.key);
          break; // No point pushing more to a dead token
        }
      }

      // Save updated device state if modified
      if (deviceUpdated) {
        const { key, ...data } = device;
        await putKV(env.TUBEPULSE_KV, key, data);
      }
    }

    // 7. Prune dead tokens
    for (const key of deadTokens) {
      console.log(`[Cron] Pruning dead token: ${key}`);
      await env.TUBEPULSE_KV.delete(key);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Cron] Done in ${elapsed}ms. Pushed ${pushCount} notifications. Pruned ${deadTokens.length} dead tokens.`);
  },
};