/**
 * TubePulse Channel Resolver — Cloudflare Worker
 *
 * Proxies YouTube Data API v3 for handle-to-channel resolution.
 * Keeps the API key server-side so it never ships in the app.
 *
 * Endpoints:
 *   GET /?handle=@mkbhd    → resolve by handle
 *   GET /?channelId=UC...  → resolve by channel ID
 *
 * Response: { channelId, name, avatar }
 *
 * Archived deploy note:
 *   This worker is retained for reference only. Do not deploy it unless
 *   deliberately restoring historical resolver behaviour.
 *
 * Historical API key setup:
 *   npx wrangler secret put YOUTUBE_API_KEY
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const handle = url.searchParams.get('handle');
    const channelId = url.searchParams.get('channelId');

    if (!handle && !channelId) {
      return json({ error: 'Provide ?handle=@handle or ?channelId=UC...' }, 400);
    }

    if (!env.YOUTUBE_API_KEY) {
      return json({ error: 'Server misconfigured — missing API key' }, 500);
    }

    try {
      let apiUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet';
      if (handle) {
        // forHandle expects the handle WITHOUT @
        const clean = handle.replace(/^@/, '');
        apiUrl += `&forHandle=${encodeURIComponent(clean)}`;
      } else {
        apiUrl += `&id=${encodeURIComponent(channelId)}`;
      }
      apiUrl += `&key=${env.YOUTUBE_API_KEY}`;

      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        const text = await resp.text();
        console.error('YouTube API error:', resp.status, text);
        return json({ error: 'Upstream API error' }, 502);
      }

      const data = await resp.json();

      if (!data.items || data.items.length === 0) {
        return json({ error: 'Channel not found' }, 404);
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
      return json({ error: 'Internal error' }, 500);
    }
  },
};

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