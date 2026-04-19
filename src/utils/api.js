/**
 * TubePulse API Client
 *
 * REST client for the tubepulse-api Cloudflare Worker.
 * Uses a persistent device UUID as authentication (not FCM token).
 * The FCM token is sent as a field in /register and updated on refresh.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const API_URL = 'https://tubepulse-api.aaronjoakley55.workers.dev';
const DEVICE_ID_KEY = 'tubepulse_device_id';

/**
 * Get or create a persistent device UUID.
 * Generated once on first launch, stored in AsyncStorage.
 */
export async function getDeviceId() {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // Generate UUID v4
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

async function apiFetch(path, options = {}) {
  const { deviceId, body, method = 'GET' } = options;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (deviceId) {
    headers['Authorization'] = `Bearer ${deviceId}`;
  }

  const fetchOptions = {
    method,
    headers,
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const resp = await fetch(`${API_URL}${path}`, fetchOptions);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error(`API ${method} ${path} failed:`, resp.status, err);
      return { ok: false, error: err.error || resp.statusText, status: resp.status };
    }

    const data = await resp.json();
    return { ok: true, ...data };
  } catch (err) {
    console.error(`API ${method} ${path} network error:`, err.message);
    return { ok: false, error: 'Network error' };
  }
}

/**
 * Register device with the API Worker.
 * Called on app launch and token refresh.
 * Uses device UUID as auth, FCM token as a field.
 */
export async function registerDevice(deviceId, fcmToken, channels, settings) {
  return await apiFetch('/register', {
    method: 'POST',
    deviceId,
    body: { fcmToken, channels, settings },
  });
}

/**
 * Update tracked channels.
 */
export async function updateChannels(deviceId, channels, fcmToken) {
  return await apiFetch('/channels', {
    method: 'PUT',
    deviceId,
    body: { channels, fcmToken },
  });
}

/**
 * Update notification settings.
 */
export async function updateSettings(deviceId, settings) {
  return await apiFetch('/settings', {
    method: 'PUT',
    deviceId,
    body: { settings },
  });
}

/**
 * Mark video(s) as seen.
 * channelId: the stable channel ID (handles can change)
 * videoIds: mark specific videos as seen (video tap)
 * clearAll: mark all current feed videos as seen (channel tap)
 */
export async function markSeen(deviceId, channelId, videoIds = [], clearAll = false) {
  const body = { channelId };
  if (clearAll) {
    body.clearAll = true;
  } else {
    body.videoIds = videoIds;
  }
  return await apiFetch('/seen', {
    method: 'POST',
    deviceId,
    body,
  });
}

/**
 * Fetch current feed data from the server.
 */
export async function fetchFeed(deviceId) {
  return await apiFetch('/feed', {
    method: 'GET',
    deviceId,
  });
}

/**
 * Bootstrap a newly added channel — fetches RSS + avatar from server.
 * Returns video data so the app can populate immediately.
 */
export async function bootstrapChannel(deviceId, channelId) {
  return await apiFetch(`/bootstrap?channelId=${encodeURIComponent(channelId)}`, {
    deviceId,
  });
}

/**
 * Resolve a YouTube handle to channelId + name + avatar.
 * Requires authentication — gated to registered devices.
 */
export async function resolveHandle(deviceId, handle) {
  const clean = handle.replace(/^@/, '');
  return await apiFetch(`/resolve?handle=@${encodeURIComponent(clean)}`, {
    deviceId,
  });
}