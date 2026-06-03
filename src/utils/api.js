/**
 * TubePulse API Client — v3.0 (channel-first architecture)
 *
 * REST client for the tubepulse-api Cloudflare Worker.
 * Uses a persistent device UUID as authentication.
 *
 * Key changes from v2:
 * - POST /subscribe-channel + POST /unsubscribe replace PUT /channels
 * - POST /bootstrap replaces GET /bootstrap
 * - POST /settings replaces PUT /settings
 * - POST /channel-override (new)
 * - GET /feed returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';

const API_URL = 'https://tubepulse-api.jimothyoakley55.workers.dev';
const DEVICE_ID_KEY = 'tubepulse_device_id';

// Module-level mutex around AsyncStorage read-or-create to prevent the
// race observed in v3.0.18 where two early calls to getDeviceId() in
// quick succession each saw an empty store and minted two different
// UUIDs for the same physical device. All callers await the same
// promise; subsequent calls short-circuit once the first resolves.
let _deviceIdPromise = null;

function _generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get a persistent device ID for this install.
 *
 * Primary path: Android's per-install `androidId` from expo-application.
 * This is stable across app launches, app updates, and is unique per
 * (device, app install) — different trial users on different phones
 * get different IDs, the same user gets the same ID across sessions.
 * Reset only on full uninstall (which is the correct semantic for our
 * cleanup policy: a new install = a new device).
 *
 * Fallback path: a random UUID generated once and stored in AsyncStorage.
 * Used when expo-application can't return an androidId (e.g. iOS sim,
 * some Android variants, Expo Go). Protected by a module-level mutex
 * so two concurrent first-launch calls can't each mint a different UUID.
 *
 * Both paths return a Promise<string>; existing callers don't need
 * to know which path was used.
 */
export async function getDeviceId() {
  // 1. Try Android ID first — no race possible, no AsyncStorage needed.
  try {
    const androidId = Application.getAndroidId();
    if (androidId && typeof androidId === 'string' && androidId.length > 0) {
      return `android:${androidId}`;
    }
  } catch (err) {
    // expo-application can throw on platforms it doesn't support.
    // Fall through to the AsyncStorage path.
    console.warn('[deviceId] Application.getAndroidId() failed, falling back to AsyncStorage UUID:', err?.message || err);
  }

  // 2. Fallback: AsyncStorage UUID with a mutex to prevent the
  //    read-or-create race that produced duplicate deviceIds in v3.0.18.
  if (_deviceIdPromise) return _deviceIdPromise;

  _deviceIdPromise = (async () => {
    let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = _generateUuid();
      await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  })();

  return _deviceIdPromise;
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
 * Only sends profile data (FCM token) — channels and settings are separate.
 */
export async function registerDevice(deviceId, fcmToken, platform = 'android', appVersion = null) {
  return await apiFetch('/register', {
    method: 'POST',
    deviceId,
    body: { fcmToken, platform, appVersion },
  });
}

/**
 * Subscribe to a channel.
 * Replaces the old PUT /channels (full list replacement) with per-channel subscribe.
 */
export async function subscribeChannel(deviceId, channelId) {
  return await apiFetch('/subscribe-channel', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Unsubscribe from a channel.
 * Replaces the old PUT /channels with per-channel unsubscribe.
 */
export async function unsubscribeChannel(deviceId, channelId) {
  return await apiFetch('/unsubscribe', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Get the device's IANA timezone (e.g. "Europe/London").
 * Falls back to "UTC" if Intl is unavailable (very old runtimes).
 */
export function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Convert local settings shape to the server-expected shape.
 * Local uses `notificationMode` (UX-friendly); server uses `mode` (compact).
 * Also stamps the current device timezone so DND works regardless of the
 * worker's UTC clock.
 */
function toServerSettings(local) {
  if (!local) return local;
  const { notificationMode, ...rest } = local;
  return {
    ...rest,
    mode: notificationMode ?? 'chill',
    dndTimezone: getLocalTimezone(),
  };
}

/**
 * Update notification settings (full replacement).
 * The local settings shape is automatically converted to the server shape.
 */
export async function updateSettings(deviceId, settings) {
  return await apiFetch('/settings', {
    method: 'POST',
    deviceId,
    body: { settings: toServerSettings(settings) },
  });
}

/**
 * Set or update per-channel notification override.
 * Empty override deletes the override (inherits from device-level).
 */
export async function setChannelOverride(deviceId, channelId, override) {
  return await apiFetch('/channel-override', {
    method: 'POST',
    deviceId,
    body: { channelId, override },
  });
}

/**
 * Mark video(s) as seen.
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
 * Returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
 */
export async function fetchFeed(deviceId) {
  return await apiFetch('/feed', {
    method: 'GET',
    deviceId,
  });
}

/**
 * Bootstrap a newly added channel — fetches RSS + avatar from server synchronously.
 * Now POST instead of GET.
 */
export async function bootstrapChannel(deviceId, channelId) {
  return await apiFetch('/bootstrap', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Resolve a YouTube handle to channelId + name + avatar.
 */
export async function resolveHandle(deviceId, handle) {
  const clean = handle.replace(/^@/, '');
  return await apiFetch(`/resolve?handle=@${encodeURIComponent(clean)}`, {
    deviceId,
  });
}