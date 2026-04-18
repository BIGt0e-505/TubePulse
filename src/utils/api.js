/**
 * TubePulse API Client
 *
 * REST client for the tubepulse-api Cloudflare Worker.
 * All requests use the FCM token as authentication.
 */

const API_URL = 'https://tubepulse-api.aaronjoakley55.workers.dev';

async function apiFetch(path, options = {}) {
  const { token, body, method = 'GET' } = options;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
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
 */
export async function registerDevice(token, channels, settings) {
  return await apiFetch('/register', {
    method: 'POST',
    token,
    body: { channels, settings },
  });
}

/**
 * Update tracked channels.
 */
export async function updateChannels(token, channels) {
  return await apiFetch('/channels', {
    method: 'PUT',
    token,
    body: { channels },
  });
}

/**
 * Update notification settings.
 */
export async function updateSettings(token, settings) {
  return await apiFetch('/settings', {
    method: 'PUT',
    token,
    body: { settings },
  });
}

/**
 * Mark video(s) as seen.
 */
export async function markSeen(token, handle, videoIds) {
  return await apiFetch('/seen', {
    method: 'POST',
    token,
    body: { handle, videoIds },
  });
}

/**
 * Fetch current feed data from the server.
 */
export async function fetchFeed(token) {
  return await apiFetch('/feed', {
    method: 'GET',
    token,
  });
}

/**
 * Resolve a YouTube handle to channelId + name + avatar.
 * No auth required — public endpoint.
 */
export async function resolveHandle(handle) {
  const clean = handle.replace(/^@/, '');
  return await apiFetch(`/resolve?handle=@${encodeURIComponent(clean)}`);
}