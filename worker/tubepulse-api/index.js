/**
 * TubePulse API Worker
 *
 * REST API for the TubePulse app + WebSub callback endpoint.
 *
 * App endpoints:
 *   POST /register       — Register/update FCM token + channels + settings
 *   PUT  /channels        — Update tracked channels for a device
 *   PUT  /settings        — Update notification settings
 *   POST /seen            — Mark video(s) as seen (video tap) or clear channel (channel tap)
 *   GET  /feed            — Get current feed data for all tracked channels
 *   GET  /resolve         — Handle → channelId resolution
 *
 * WebSub endpoints:
 *   GET  /websub          — Verification handshake (subscribe/unsubscribe)
 *   POST /websub          — Push notification from YouTube (new video detected)
 */

// ─── Helpers ────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

// ─── Auth ───────────────────────────────────────────────────────────────

function getDeviceId(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

// ─── KV helpers ─────────────────────────────────────────────────────────

const KV_PREFIX_DEVICE = 'device:';
const KV_PREFIX_CHANNEL_META = 'channel:';
const KV_PREFIX_CHANNEL_FEED = 'feed:';
const KV_PREFIX_SUBSCRIPTION = 'sub:';  // WebSub subscription state per channel

async function getKV(kv, key) {
  return await kv.get(key, 'json');
}

async function putKV(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function getDevice(kv, token) {
  return await kv.get(KV_PREFIX_DEVICE + token, 'json');
}

async function putDevice(kv, token, data) {
  await kv.put(KV_PREFIX_DEVICE + token, JSON.stringify(data));
}

// ─── YouTube RSS ────────────────────────────────────────────────────────

async function fetchYouTubeRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(feedUrl, { signal: controller.signal });
    if (!resp.ok) return null;

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

// ─── WebSub subscription management ────────────────────────────────────

const HUB_URL = 'https://pubsubhubbub.appspot.com/';
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

async function subscribeToChannel(channelId, callbackUrl, secret) {
  const feedUrl = `${FEED_TEMPLATE}${channelId}`;
  const body = new URLSearchParams({
    'hub.callback': callbackUrl,
    'hub.mode': 'subscribe',
    'hub.topic': feedUrl,
    'hub.verify': 'sync',
    'hub.lease_seconds': String(86400 * 5), // 5 days
    'hub.secret': secret,
  });

  try {
    const resp = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    console.log(`[WebSub] Subscribe request for ${channelId}: ${resp.status}`);
    return resp.ok || resp.status === 202 || resp.status === 204;
  } catch (err) {
    console.error(`[WebSub] Subscribe failed for ${channelId}:`, err.message);
    return false;
  }
}

async function unsubscribeFromChannel(channelId, callbackUrl) {
  const feedUrl = `${FEED_TEMPLATE}${channelId}`;
  const body = new URLSearchParams({
    'hub.callback': callbackUrl,
    'hub.mode': 'unsubscribe',
    'hub.topic': feedUrl,
    'hub.verify': 'sync',
  });

  try {
    await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    console.log(`[WebSub] Unsubscribe request for ${channelId}`);
  } catch (err) {
    console.error(`[WebSub] Unsubscribe failed for ${channelId}:`, err.message);
  }
}

// Check if any device still tracks a channel
async function isChannelTracked(kv, channelId) {
  let cursor = undefined;
  do {
    const list = await kv.list({ prefix: KV_PREFIX_DEVICE, cursor });
    for (const key of list.keys) {
      const device = await kv.get(key.name, 'json');
      if (device?.channels?.some((ch) => ch.channelId === channelId)) {
        return true;
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return false;
}

// ─── WebSub HMAC verification ────────────────────────────────────────────

async function verifyWebSubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  // X-Hub-Signature format: "sha256=<hex>"
  const match = signatureHeader.match(/^sha256=(.+)$/i);
  if (!match) return false;

  const expectedHex = match[1];

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return sigHex === expectedHex;
}

// ─── XML Parser (lightweight, no dependency) ────────────────────────────

function parseWebSubPush(xmlText) {
  // WebSub pushes the full Atom feed — extract video entries
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entryXml = match[1];

    const videoId = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entryXml.match(/<title>([^<]+)<\/title>/)?.[1];
    const link = entryXml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1]
      || entryXml.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/)?.[1]
      || `https://www.youtube.com/watch?v=${videoId}`;
    const published = entryXml.match(/<published>([^<]+)<\/published>/)?.[1];
    const updated = entryXml.match(/<updated>([^<]+)<\/updated>/)?.[1];

    const thumbMatch = entryXml.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1] : null;

    const descMatch = entryXml.match(/<media:description>([^<]*)<\/media:description>/);
    const description = descMatch ? descMatch[1] : '';

    if (videoId) {
      entries.push({ videoId, title, link, published, updated, thumbnail, description });
    }
  }

  // Extract channel info from feed-level
  const channelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
  const channelName = xmlText.match(/<name>([^<]+)<\/name>/)?.[1];

  return { channelId, channelName, entries };
}

// ─── Route handlers ─────────────────────────────────────────────────────

/**
 * POST /register
 * Body: { channels: [{handle, channelId, name?}], settings: {...} }
 * Registers or updates a device. Called on app launch + token refresh.
 * Also ensures WebSub subscriptions exist for all tracked channels.
 */
async function handleRegister(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { fcmToken, channels = [], settings = {} } = body;

  if (!fcmToken) return errorResponse('fcmToken is required');
  if (!Array.isArray(channels)) return errorResponse('channels must be an array');

  for (const ch of channels) {
    if (!ch.handle) return errorResponse('Each channel must have a handle');
  }

  const existing = await getDevice(env.TUBEPULSE_KV, deviceId);
  const now = Date.now();

  const device = {
    fcmToken, // mutable — updated on token refresh
    channels,
    settings: {
      notificationMode: settings.notificationMode || 'chill',
      nagInterval: settings.nagInterval || 15,
      includeCommunityPosts: settings.includeCommunityPosts || false,
      dndEnabled: settings.dndEnabled || false,
      dndStart: settings.dndStart || '22:00',
      dndEnd: settings.dndEnd || '07:00',
      perChannelNotifications: settings.perChannelNotifications || false,
      channelNotifSettings: settings.channelNotifSettings || {},
      tapAction: settings.tapAction || 'video',
    },
    lastSeen: existing?.lastSeen || {},
    registeredAt: existing?.registeredAt || now,
    lastActiveAt: now,
  };

  await putDevice(env.TUBEPULSE_KV, deviceId, device);

  // Auto-refresh channel avatars on first register + ensure WebSub subscriptions
  const callbackUrl = `${new URL(request.url).origin}/websub`;
  ctx.waitUntil((async () => {
    for (const ch of channels) {
      if (!ch.channelId) continue;

      // Fetch avatar if missing
      const existingMeta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + ch.channelId);
      if (!existingMeta && env.YOUTUBE_API_KEY) {
        try {
          const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${ch.channelId}&key=${env.YOUTUBE_API_KEY}`;
          const chResp = await fetch(apiUrl);
          if (chResp.ok) {
            const chData = await chResp.json();
            if (chData.items?.[0]) {
              const item = chData.items[0];
              const thumbs = item.snippet?.thumbnails || {};
              const meta = {
                name: item.snippet?.title || ch.name || ch.handle,
                avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
                lastVideoId: null,
                lastVideoTitle: null,
                lastVideoPublished: null,
                lastChecked: new Date().toISOString(),
              };
              await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + ch.channelId, meta);
              console.log(`[API] Auto-refreshed channel: ${ch.handle}`);
            }
          }
        } catch (e) {
          console.warn(`[API] Auto-refresh failed for ${ch.handle}:`, e.message);
        }
      }

      // Subscribe to WebSub if not already subscribed
      const subState = await getKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + ch.channelId);
      if (!subState) {
        // Generate a random secret for HMAC verification
        const secret = crypto.randomUUID();
        const success = await subscribeToChannel(ch.channelId, callbackUrl, secret);
        if (success) {
          await putKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + ch.channelId, {
            subscribedAt: Date.now(),
            leaseExpires: Date.now() + 86400 * 5 * 1000,
            secret,
          });
        }
      }
    }
  })());

  return json({ ok: true, registeredAt: device.registeredAt });
}

/**
 * PUT /channels
 * Body: { channels: [{handle, channelId, name?}] }
 * Updates the channel list. Handles WebSub subscribe/unsubscribe.
 */
async function handleChannels(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { channels = [], fcmToken } = body;
  if (!Array.isArray(channels)) return errorResponse('channels must be an array');
  for (const ch of channels) {
    if (!ch.handle) return errorResponse('Each channel must have a handle');
  }

  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  // Update FCM token if provided (on token refresh)
  if (fcmToken) device.fcmToken = fcmToken;

  const oldChannelIds = new Set((device.channels || []).map((ch) => ch.channelId).filter(Boolean));
  const newChannelIds = new Set(channels.map((ch) => ch.channelId).filter(Boolean));

  device.channels = channels;
  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, deviceId, device);

  const callbackUrl = `${new URL(request.url).origin}/websub`;
  ctx.waitUntil((async () => {
    // Subscribe to new channels
    for (const ch of channels) {
      if (!ch.channelId) continue;
      if (oldChannelIds.has(ch.channelId)) continue; // already tracked

      const subState = await getKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + ch.channelId);
      if (!subState) {
        const secret = crypto.randomUUID();
        const success = await subscribeToChannel(ch.channelId, callbackUrl, secret);
        if (success) {
          await putKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + ch.channelId, {
            subscribedAt: Date.now(),
            leaseExpires: Date.now() + 86400 * 5 * 1000,
            secret,
          });
        }
      }

      // Fetch avatar if missing
      const existingMeta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + ch.channelId);
      if (!existingMeta && env.YOUTUBE_API_KEY) {
        try {
          const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${ch.channelId}&key=${env.YOUTUBE_API_KEY}`;
          const chResp = await fetch(apiUrl);
          if (chResp.ok) {
            const chData = await chResp.json();
            if (chData.items?.[0]) {
              const item = chData.items[0];
              const thumbs = item.snippet?.thumbnails || {};
              await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + ch.channelId, {
                name: item.snippet?.title || ch.name || ch.handle,
                avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
                lastVideoId: null,
                lastVideoTitle: null,
                lastVideoPublished: null,
                lastChecked: new Date().toISOString(),
              });
            }
          }
        } catch (e) {
          console.warn(`[API] Avatar fetch failed for ${ch.handle}:`, e.message);
        }
      }
    }

    // Unsubscribe from removed channels (only if no other device tracks them)
    for (const channelId of oldChannelIds) {
      if (newChannelIds.has(channelId)) continue;
      const tracked = await isChannelTracked(env.TUBEPULSE_KV, channelId);
      if (!tracked) {
        await unsubscribeFromChannel(channelId, callbackUrl);
        // Clean up subscription state (keep meta + feed for any stragglers)
        await env.TUBEPULSE_KV.delete(KV_PREFIX_SUBSCRIPTION + channelId);
      }
    }
  })());

  return json({ ok: true });
}

/**
 * PUT /settings
 * Body: { settings: {...} }
 */
async function handleSettings(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { settings = {} } = body;

  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  device.settings = { ...device.settings, ...settings };
  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, deviceId, device);

  return json({ ok: true });
}

/**
 * POST /seen
 * Body: { channelId: string, videoIds: string[] }  — mark specific videos as seen (video tap)
 *    or { channelId: string, clearAll: true }        — clear all unwatched for channel (channel tap)
 * channelId is the stable primary key (handles can change).
 */
async function handleSeen(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { channelId, videoIds, clearAll } = body;
  if (!channelId) return errorResponse('channelId is required');

  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  // Look up handle from channel list (handle is the key in lastSeen for backwards compat)
  const channel = device.channels.find((ch) => ch.channelId === channelId);
  const handle = channel?.handle || channelId;

  if (!device.lastSeen) device.lastSeen = {};
  if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };

  if (clearAll) {
    // Channel tap: mark all currently unwatched videos as seen
    const feed = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId);
    if (feed?.videos) {
      const existing = new Set(device.lastSeen[handle].seenIds || []);
      for (const v of feed.videos) {
        if (v.videoId) existing.add(v.videoId);
      }
      device.lastSeen[handle].seenIds = [...existing];
    }
  } else if (Array.isArray(videoIds)) {
    // Video tap: mark specific videos as seen
    const existing = new Set(device.lastSeen[handle].seenIds || []);
    for (const id of videoIds) {
      existing.add(id);
      // Remove from nagState so cron stops re-nagging this video
      if (device.lastSeen[handle].nagState?.[id]) {
        delete device.lastSeen[handle].nagState[id];
      }
    }
    device.lastSeen[handle].seenIds = [...existing];
    // If gentle state is for one of these videos, clear it
    if (device.lastSeen[handle].gentleState && videoIds.includes(device.lastSeen[handle].gentleState.videoId)) {
      delete device.lastSeen[handle].gentleState;
    }
  } else {
    return errorResponse('Provide videoIds array or clearAll: true');
  }

  // Clear gentle/nag state for this channel
  if (device.lastSeen[handle].gentleState) {
    delete device.lastSeen[handle].gentleState;
  }
  if (device.lastSeen[handle].nagState) {
    delete device.lastSeen[handle].nagState;
  }
  if (device.lastSeen[handle].scheduledState) {
    delete device.lastSeen[handle].scheduledState;
  }

  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, deviceId, device);

  return json({ ok: true, seenCount: device.lastSeen[handle].seenIds.length });
}

/**
 * GET /feed
 * Returns current feed data for all channels the device tracks.
 */
async function handleFeed(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, deviceId, device);

  const feeds = {};
  const channelIds = device.channels
    .map((ch) => ch.channelId)
    .filter(Boolean);

  const feedPromises = channelIds.map(async (channelId) => {
    const [meta, feed] = await Promise.all([
      getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId),
      getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId),
    ]);
    return { channelId, meta, feed };
  });

  const results = await Promise.all(feedPromises);

  for (const { channelId, meta, feed } of results) {
    const channel = device.channels.find((ch) => ch.channelId === channelId);
    const handle = channel?.handle || channelId;
    feeds[handle] = {
      name: meta?.name || channel?.name || handle,
      avatar: meta?.avatar || null,
      videos: feed?.videos || [],
      lastChecked: meta?.lastChecked || null,
    };
  }

  return json({
    channels: device.channels,
    settings: device.settings,
    lastSeen: device.lastSeen,
    feeds,
  });
}

/**
 * GET /resolve?handle=@mkbhd
 */
async function handleResolve(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Authentication required', 401);

  // Verify device is registered
  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  const url = new URL(request.url);
  const handle = url.searchParams.get('handle');
  const channelId = url.searchParams.get('channelId');

  if (!handle && !channelId) {
    return errorResponse('Provide ?handle=@handle or ?channelId=UC...', 400);
  }

  if (!env.YOUTUBE_API_KEY) {
    return errorResponse('Server misconfigured — missing API key', 500);
  }

  try {
    // If channelId provided, resolve directly
    if (channelId) {
      const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(channelId)}&key=${env.YOUTUBE_API_KEY}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) return errorResponse('Upstream API error', 502);
      const data = await resp.json();
      if (!data.items?.length) return errorResponse('Channel not found', 404);
      const ch = data.items[0];
      const thumbs = ch.snippet?.thumbnails || {};
      return json({
        channelId: ch.id,
        name: ch.snippet?.title || null,
        avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
      }, 200, { 'Cache-Control': 'public, max-age=3600' });
    }

    // Try forHandle first, then fallback to forUsername
    const clean = handle.replace(/^@/, '');

    // Attempt 1: forHandle (works for @handles)
    let apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(clean)}&key=${env.YOUTUBE_API_KEY}`;
    let resp = await fetch(apiUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.items?.length) {
        const ch = data.items[0];
        const thumbs = ch.snippet?.thumbnails || {};
        return json({
          channelId: ch.id,
          name: ch.snippet?.title || null,
          avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
        }, 200, { 'Cache-Control': 'public, max-age=3600' });
      }
    }

    // Attempt 2: forUsername fallback (works for legacy custom URLs)
    apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forUsername=${encodeURIComponent(clean)}&key=${env.YOUTUBE_API_KEY}`;
    resp = await fetch(apiUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.items?.length) {
        const ch = data.items[0];
        const thumbs = ch.snippet?.thumbnails || {};
        return json({
          channelId: ch.id,
          name: ch.snippet?.title || null,
          avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
        }, 200, { 'Cache-Control': 'public, max-age=3600' });
      }
    }

    // Neither worked
    return errorResponse('Channel not found', 404);
  } catch (err) {
    console.error('Resolver error:', err);
    return errorResponse('Internal error', 500);
  }
}

// ─── WebSub handlers ────────────────────────────────────────────────────

/**
 * GET /websub
 * WebSub verification handshake.
 * Hub sends: hub.mode, hub.topic, hub.challenge, hub.lease_seconds
 * We must: respond with hub.challenge as plain text (200)
 */
async function handleWebSubVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');
  const challenge = url.searchParams.get('hub.challenge');
  const leaseSeconds = url.searchParams.get('hub.lease_seconds');

  if (!mode || !topic || !challenge) {
    console.warn('[WebSub] Invalid verification request');
    return new Response('Missing parameters', { status: 400 });
  }

  // Extract channelId from topic URL
  const channelIdMatch = topic.match(/channel_id=([A-Za-z0-9_-]+)/);
  const channelId = channelIdMatch ? channelIdMatch[1] : null;

  if (!channelId) {
    console.warn('[WebSub] Could not extract channelId from topic:', topic);
    return new Response('Invalid topic', { status: 400 });
  }

  if (mode === 'subscribe') {
    // Store/update subscription state
    const leaseMs = leaseSeconds ? parseInt(leaseSeconds) * 1000 : 86400 * 5 * 1000;
    await putKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + channelId, {
      subscribedAt: Date.now(),
      leaseExpires: Date.now() + leaseMs,
    });
    console.log(`[WebSub] Subscribed to ${channelId}, lease: ${leaseSeconds}s`);
  } else if (mode === 'unsubscribe') {
    await env.TUBEPULSE_KV.delete(KV_PREFIX_SUBSCRIPTION + channelId);
    console.log(`[WebSub] Unsubscribed from ${channelId}`);
  }

  // Must respond with the challenge as plain text
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/**
 * POST /websub
 * WebSub push — YouTube notifies us of new content.
 * Body: Atom XML feed for the channel.
 */
async function handleWebSubPush(request, env, ctx) {
  // Verify HMAC signature
  const signature = request.headers.get('X-Hub-Signature');

  let xmlText;
  try {
    xmlText = await request.text();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // Extract channelId from the XML to look up the secret
  const quickChannelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
  if (quickChannelId && signature) {
    const subState = await getKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + quickChannelId);
    if (subState?.secret) {
      const valid = await verifyWebSubSignature(xmlText, signature, subState.secret);
      if (!valid) {
        console.warn(`[WebSub] Invalid signature for ${quickChannelId} — rejecting`);
        return new Response('Forbidden', { status: 403 });
      }
    }
  }

  const parsed = parseWebSubPush(xmlText);
  if (!parsed.channelId || parsed.entries.length === 0) {
    // Empty or malformed push — acknowledge but do nothing
    return new Response('OK', { status: 200 });
  }

  const channelId = parsed.channelId;
  const channelName = parsed.channelName;

  console.log(`[WebSub] Push for ${channelId}: ${parsed.entries.length} entries`);

  // Update channel meta and feed
  const prevMeta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId);

  const meta = {
    name: channelName || prevMeta?.name || channelId,
    avatar: prevMeta?.avatar || null, // Preserve avatar (set at add time)
    lastVideoId: parsed.entries[0]?.videoId || prevMeta?.lastVideoId || null,
    lastVideoTitle: parsed.entries[0]?.title || prevMeta?.lastVideoTitle || null,
    lastVideoPublished: parsed.entries[0]?.published || prevMeta?.lastVideoPublished || null,
    lastChecked: new Date().toISOString(),
  };

  await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId, meta);

  // Update feed (top 5 entries), refreshing title/thumbnail if <updated> changed
  const prevFeed = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId);
  const prevVideos = prevFeed?.videos || [];

  const feed = {
    videos: parsed.entries.slice(0, 5).map((e) => {
      // If we already have this video, preserve it unless <updated> changed
      const prev = prevVideos.find((v) => v.videoId === e.videoId);
      if (prev && prev.updated === e.updated) return prev; // No change

      return {
        videoId: e.videoId,
        title: e.title,
        published: e.published,
        updated: e.updated,
        link: e.link,
        thumbnail: e.thumbnail,
        description: e.description,
        views: '0',
      };
    }),
    lastFetched: new Date().toISOString(),
  };
  await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId, feed);

  // Detect if there's actually a NEW video (compared to prevMeta)
  const newVideoId = parsed.entries[0]?.videoId;
  const prevVideoId = prevMeta?.lastVideoId;
  const isNewVideo = newVideoId && newVideoId !== prevVideoId;

  if (!isNewVideo) {
    console.log(`[WebSub] No new video (same as prev: ${prevVideoId})`);
    return new Response('OK', { status: 200 });
  }

  console.log(`[WebSub] NEW video: ${newVideoId} — "${parsed.entries[0].title}"`);

  // Check if this is a scheduled event (published time in the future)
  const publishedTime = parsed.entries[0].published
    ? new Date(parsed.entries[0].published).getTime()
    : 0;
  const isScheduled = publishedTime > Date.now();

  // Find devices tracking this channel
  ctx.waitUntil((async () => {
    // Get FCM access token
    let accessToken;
    try {
      accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('[WebSub] Failed to get FCM access token:', err);
      return;
    }

    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = sa.project_id;

    const deviceKeys = [];
    let cursor = undefined;
    do {
      const list = await env.TUBEPULSE_KV.list({ prefix: KV_PREFIX_DEVICE, cursor });
      for (const key of list.keys) {
        deviceKeys.push(key.name);
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    for (const key of deviceKeys) {
      const device = await getKV(env.TUBEPULSE_KV, key);
      if (!device) continue;

      const tracksChannel = device.channels?.some(
        (ch) => ch.channelId === channelId
      );
      if (!tracksChannel) continue;

      const fcmToken = device.fcmToken;
      const handle = device.channels.find(
        (ch) => ch.channelId === channelId
      )?.handle;

      if (!handle) continue;

      // Check if already seen
      const seenIds = device.lastSeen?.[handle]?.seenIds || [];
      if (seenIds.includes(newVideoId)) continue;

      // Get effective settings
      const perChannelEnabled = device.settings?.perChannelNotifications || false;
      const channelOverride = perChannelEnabled
        ? device.settings?.channelNotifSettings?.[handle]
        : null;
      const effectiveSettings = channelOverride
        ? { ...device.settings, ...channelOverride }
        : device.settings;

      const mode = effectiveSettings?.notificationMode || 'chill';

      if (isScheduled) {
        // Scheduled premiere/live — store as pending, don't notify now
        // Nag cron will send "upcoming" notification 1 nag interval before
        if (!device.lastSeen) device.lastSeen = {};
        if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };
        if (!device.lastSeen[handle].scheduledState) device.lastSeen[handle].scheduledState = {};

        device.lastSeen[handle].scheduledState[newVideoId] = {
          publishedTime,
          detectedAt: Date.now(),
          notified: false,       // haven't sent "upcoming" yet
          wentLiveNotified: false, // haven't sent "now available" yet
        };
        await putDevice(env.TUBEPULSE_KV, key, device);
        console.log(`[WebSub] Stored scheduled event ${newVideoId} for ${handle} (airs ${new Date(publishedTime).toISOString()})`);
        continue;
      }

      // Not scheduled — available now. Send immediate notification.

      // DND blocks all pushes
      const globalDndEnabled = device.settings?.dndEnabled || false;
      const globalDndActive = globalDndEnabled && isDndActive(
        device.settings?.dndStart || '22:00',
        device.settings?.dndEnd || '07:00'
      );
      const channelDndEnabled = effectiveSettings?.dndEnabled || false;
      const channelDndActive = channelDndEnabled && isDndActive(
        effectiveSettings?.dndStart || '22:00',
        effectiveSettings?.dndEnd || '07:00'
      );

      if (globalDndActive || channelDndActive) {
        // DND active — skip, nag cron catches later
        continue;
      }

      // Store nag/gentle state
      if (mode === 'chill') {
        if (!device.lastSeen) device.lastSeen = {};
        if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };
        device.lastSeen[handle].gentleState = {
          videoId: newVideoId,
          firstNotifiedAt: Date.now(),
          lastRemindedAt: Date.now(),
        };
        await putDevice(env.TUBEPULSE_KV, key, device);
      }

      if (mode === 'relentless') {
        if (!device.lastSeen) device.lastSeen = {};
        if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };
        if (!device.lastSeen[handle].nagState) device.lastSeen[handle].nagState = {};
        device.lastSeen[handle].nagState[newVideoId] = {
          firstNotifiedAt: Date.now(),
          lastNotifiedAt: Date.now(),
        };
        await putDevice(env.TUBEPULSE_KV, key, device);
      }

      // Send push
      const result = await sendFCMPush(accessToken, projectId, fcmToken, {
        title: `${channelName || handle} uploaded`,
        body: parsed.entries[0].title,
        data: {
          videoId: newVideoId,
          channelId,
          channelName: channelName || handle,
          handle,
          videoLink: parsed.entries[0].link,
          type: 'new_video',
        },
        silent: false,
      });

      if (result.deadToken) {
        console.log(`[WebSub] Pruning dead token: ${key}`);
        await env.TUBEPULSE_KV.delete(key);
      }
    }
  })());

  return new Response('OK', { status: 200 });
}

// ─── Bootstrap endpoint ─────────────────────────────────────────────────

/**
 * GET /bootstrap?channelId=UC...
 * Fetches RSS + avatar for a newly added channel synchronously.
 * Returns the feed data so the app can populate immediately.
 */
async function handleBootstrap(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Authentication required', 401);

  const device = await getDevice(env.TUBEPULSE_KV, deviceId);
  if (!device) return errorResponse('Device not registered', 404);

  const url = new URL(request.url);
  const channelId = url.searchParams.get('channelId');
  if (!channelId) return errorResponse('channelId is required');

  // Verify this device tracks this channel
  const tracks = device.channels?.some((ch) => ch.channelId === channelId);
  if (!tracks) return errorResponse('Channel not tracked by this device', 404);

  const callbackUrl = `${new URL(request.url).origin}/websub`;

  // Fetch avatar if missing
  const existingMeta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId);
  let meta = existingMeta;

  if (!existingMeta && env.YOUTUBE_API_KEY) {
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${env.YOUTUBE_API_KEY}`;
      const chResp = await fetch(apiUrl);
      if (chResp.ok) {
        const chData = await chResp.json();
        if (chData.items?.[0]) {
          const item = chData.items[0];
          const thumbs = item.snippet?.thumbnails || {};
          meta = {
            name: item.snippet?.title,
            avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
            lastVideoId: null,
            lastVideoTitle: null,
            lastVideoPublished: null,
            lastChecked: new Date().toISOString(),
          };
          await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId, meta);
        }
      }
    } catch (e) {
      console.warn(`[Bootstrap] Avatar fetch failed for ${channelId}:`, e.message);
    }
  }

  // Fetch RSS feed
  const rssResult = await fetchYouTubeRSS(channelId);
  let feed = { videos: [], lastFetched: new Date().toISOString() };

  if (rssResult?.videos?.length > 0) {
    feed = {
      videos: rssResult.videos.slice(0, 5),
      lastFetched: new Date().toISOString(),
    };

    // Update meta with latest video info
    if (!meta) {
      meta = {
        name: rssResult.channel?.name || channelId,
        avatar: null,
        lastVideoId: rssResult.videos[0]?.videoId || null,
        lastVideoTitle: rssResult.videos[0]?.title || null,
        lastVideoPublished: rssResult.videos[0]?.published || null,
        lastChecked: new Date().toISOString(),
      };
    } else {
      meta.lastVideoId = rssResult.videos[0]?.videoId || meta.lastVideoId;
      meta.lastVideoTitle = rssResult.videos[0]?.title || meta.lastVideoTitle;
      meta.lastVideoPublished = rssResult.videos[0]?.published || meta.lastVideoPublished;
      meta.lastChecked = new Date().toISOString();
    }

    await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + channelId, meta);
    await putKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + channelId, feed);
  }

  // Subscribe to WebSub (async, don't block response)
  ctx.waitUntil((async () => {
    const subState = await getKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + channelId);
    if (!subState) {
      const secret = crypto.randomUUID();
      const success = await subscribeToChannel(channelId, callbackUrl, secret);
      if (success) {
        await putKV(env.TUBEPULSE_KV, KV_PREFIX_SUBSCRIPTION + channelId, {
          subscribedAt: Date.now(),
          leaseExpires: Date.now() + 86400 * 5 * 1000,
          secret,
        });
      }
    }
  })());

  const channel = device.channels.find((ch) => ch.channelId === channelId);
  const handle = channel?.handle || channelId;

  return json({
    ok: true,
    channelId,
    handle,
    name: meta?.name || handle,
    avatar: meta?.avatar || null,
    videos: feed.videos,
  });
}

// ─── DND logic ──────────────────────────────────────────────────────────

function isDndActive(dndStart, dndEnd) {
  const now = new Date();
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

// ─── FCM helpers (shared with cron) ─────────────────────────────────────

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

// ─── Main handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // WebSub verification (GET /websub)
      if (path === '/websub' && request.method === 'GET') {
        return await handleWebSubVerification(request, env);
      }

      // WebSub push (POST /websub)
      if (path === '/websub' && request.method === 'POST') {
        return await handleWebSubPush(request, env, ctx);
      }

      // App routes
      if (path === '/resolve' && request.method === 'GET') {
        return await handleResolve(request, env);
      }

      if (path === '/register' && request.method === 'POST') {
        return await handleRegister(request, env, ctx);
      }

      if (path === '/channels' && request.method === 'PUT') {
        return await handleChannels(request, env, ctx);
      }

      if (path === '/settings' && request.method === 'PUT') {
        return await handleSettings(request, env);
      }

      if (path === '/seen' && request.method === 'POST') {
        return await handleSeen(request, env);
      }

      if (path === '/feed' && request.method === 'GET') {
        return await handleFeed(request, env);
      }

      if (path === '/bootstrap' && request.method === 'GET') {
        return await handleBootstrap(request, env, ctx);
      }

      if (path === '/' && request.method === 'GET') {
        return json({ status: 'ok', version: '2.0.0', worker: 'tubepulse-api' });
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal server error', 500);
    }
  },
};