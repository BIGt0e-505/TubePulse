/**
 * TubePulse API Worker
 *
 * REST API for the TubePulse app:
 *   POST /register   — Register/update FCM token + channels + settings
 *   PUT  /channels   — Update tracked channels for a device
 *   PUT  /settings   — Update notification settings
 *   POST /seen        — Mark video(s) as seen
 *   GET  /feed        — Get current feed data for all tracked channels
 *   GET  /resolve     — Handle → channelId resolution (migrated from resolver)
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

// Extract FCM token from Authorization header: "Bearer <token>"
function getFcmToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

// ─── KV helpers ─────────────────────────────────────────────────────────

const KV_PREFIX_DEVICE = 'device:';
const KV_PREFIX_CHANNEL_META = 'channel:';
const KV_PREFIX_CHANNEL_FEED = 'feed:';

async function getDevice(kv, token) {
  const data = await kv.get(KV_PREFIX_DEVICE + token, 'json');
  return data;
}

async function putDevice(kv, token, data) {
  await kv.put(KV_PREFIX_DEVICE + token, JSON.stringify(data));
}

async function getChannelMeta(kv, channelId) {
  return await kv.get(KV_PREFIX_CHANNEL_META + channelId, 'json');
}

async function putChannelMeta(kv, channelId, data) {
  await kv.put(KV_PREFIX_CHANNEL_META + channelId, JSON.stringify(data));
}

async function getChannelFeed(kv, channelId) {
  return await kv.get(KV_PREFIX_CHANNEL_FEED + channelId, 'json');
}

// ─── Route handlers ─────────────────────────────────────────────────────

/**
 * POST /register
 * Body: { channels: [{handle, channelId, name?}], settings: {...} }
 * Registers or updates a device. Called on app launch + token refresh.
 */
async function handleRegister(request, env) {
  const token = getFcmToken(request);
  if (!token) return errorResponse('Missing Authorization: Bearer <fcm-token>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { channels = [], settings = {} } = body;

  if (!Array.isArray(channels)) return errorResponse('channels must be an array');

  // Validate channel entries
  for (const ch of channels) {
    if (!ch.handle) return errorResponse('Each channel must have a handle');
  }

  const existing = await getDevice(env.TUBEPULSE_KV, token);
  const now = Date.now();

  const device = {
    channels,
    settings: {
      notificationMode: settings.notificationMode || 'relentless',
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

  await putDevice(env.TUBEPULSE_KV, token, device);

  return json({ ok: true, registeredAt: device.registeredAt });
}

/**
 * PUT /channels
 * Body: { channels: [{handle, channelId, name?}] }
 * Updates the channel list for a device.
 */
async function handleChannels(request, env) {
  const token = getFcmToken(request);
  if (!token) return errorResponse('Missing Authorization: Bearer <fcm-token>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { channels = [] } = body;
  if (!Array.isArray(channels)) return errorResponse('channels must be an array');
  for (const ch of channels) {
    if (!ch.handle) return errorResponse('Each channel must have a handle');
  }

  const device = await getDevice(env.TUBEPULSE_KV, token);
  if (!device) return errorResponse('Device not registered', 404);

  device.channels = channels;
  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, token, device);

  return json({ ok: true });
}

/**
 * PUT /settings
 * Body: { settings: {...} }
 * Updates notification settings for a device.
 */
async function handleSettings(request, env) {
  const token = getFcmToken(request);
  if (!token) return errorResponse('Missing Authorization: Bearer <fcm-token>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { settings = {} } = body;

  const device = await getDevice(env.TUBEPULSE_KV, token);
  if (!device) return errorResponse('Device not registered', 404);

  device.settings = { ...device.settings, ...settings };
  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, token, device);

  return json({ ok: true });
}

/**
 * POST /seen
 * Body: { handle: string, videoIds: string[] }
 * Marks videos as seen for a device.
 */
async function handleSeen(request, env) {
  const token = getFcmToken(request);
  if (!token) return errorResponse('Missing Authorization: Bearer <fcm-token>', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const { handle, videoIds = [] } = body;
  if (!handle) return errorResponse('handle is required');
  if (!Array.isArray(videoIds)) return errorResponse('videoIds must be an array');

  const device = await getDevice(env.TUBEPULSE_KV, token);
  if (!device) return errorResponse('Device not registered', 404);

  if (!device.lastSeen) device.lastSeen = {};
  if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };

  const existing = new Set(device.lastSeen[handle].seenIds || []);
  for (const id of videoIds) {
    existing.add(id);
  }
  device.lastSeen[handle].seenIds = [...existing];
  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, token, device);

  return json({ ok: true, seenCount: existing.size });
}

/**
 * GET /feed
 * Returns current feed data for all channels the device tracks.
 * Reads from KV channel feed cache (populated by the cron worker).
 */
async function handleFeed(request, env) {
  const token = getFcmToken(request);
  if (!token) return errorResponse('Missing Authorization: Bearer <fcm-token>', 401);

  const device = await getDevice(env.TUBEPULSE_KV, token);
  if (!device) return errorResponse('Device not registered', 404);

  device.lastActiveAt = Date.now();
  await putDevice(env.TUBEPULSE_KV, token, device);

  const feeds = {};
  const channelIds = device.channels
    .map(ch => ch.channelId)
    .filter(Boolean);

  // Fetch all channel feeds in parallel
  const feedPromises = channelIds.map(async (channelId) => {
    const [meta, feed] = await Promise.all([
      getChannelMeta(env.TUBEPULSE_KV, channelId),
      getChannelFeed(env.TUBEPULSE_KV, channelId),
    ]);
    return { channelId, meta, feed };
  });

  const results = await Promise.all(feedPromises);

  for (const { channelId, meta, feed } of results) {
    // Find the handle for this channel
    const channel = device.channels.find(ch => ch.channelId === channelId);
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
 * Migrated from the original tubepulse-resolver worker.
 * Resolves YouTube handle → channelId + name + avatar.
 */
async function handleResolve(request, env) {
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
    let apiUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet';
    if (handle) {
      const clean = handle.replace(/^@/, '');
      apiUrl += `&forHandle=${encodeURIComponent(clean)}`;
    } else {
      apiUrl += `&id=${encodeURIComponent(channelId)}`;
    }
    apiUrl += `&key=${env.YOUTUBE_API_KEY}`;

    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      console.error('YouTube API error:', resp.status);
      return errorResponse('Upstream API error', 502);
    }

    const data = await resp.json();
    if (!data.items || data.items.length === 0) {
      return errorResponse('Channel not found', 404);
    }

    const channel = data.items[0];
    const thumbs = channel.snippet?.thumbnails || {};
    const avatar =
      thumbs.high?.url ||
      thumbs.medium?.url ||
      thumbs.default?.url ||
      null;

    return json(
      {
        channelId: channel.id,
        name: channel.snippet?.title || null,
        avatar,
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' }
    );
  } catch (err) {
    console.error('Resolver error:', err);
    return errorResponse('Internal error', 500);
  }
}

// ─── Main handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route: Resolve (no auth required — public endpoint)
      if (path === '/resolve' && request.method === 'GET') {
        return await handleResolve(request, env);
      }

      // Route: Register
      if (path === '/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      }

      // Route: Channels
      if (path === '/channels' && request.method === 'PUT') {
        return await handleChannels(request, env);
      }

      // Route: Settings
      if (path === '/settings' && request.method === 'PUT') {
        return await handleSettings(request, env);
      }

      // Route: Seen
      if (path === '/seen' && request.method === 'POST') {
        return await handleSeen(request, env);
      }

      // Route: Feed
      if (path === '/feed' && request.method === 'GET') {
        return await handleFeed(request, env);
      }

      // Health check
      if (path === '/' && request.method === 'GET') {
        return json({ status: 'ok', version: '1.0.0', worker: 'tubepulse-api' });
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal server error', 500);
    }
  },
};