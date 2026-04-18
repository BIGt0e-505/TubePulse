import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// Cloudflare Worker proxy for YouTube Data API v3 — keeps API key server-side
const RESOLVER_URL = 'https://tubepulse-resolver.aaronjoakley55.workers.dev';

// Fetch with a timeout so the app never hangs
function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Resolve @handle to channel ID via our Cloudflare Worker proxy (YouTube Data API v3)
export async function resolveChannelId(handle) {
  try {
    const resp = await fetchWithTimeout(
      `${RESOLVER_URL}?handle=@${encodeURIComponent(handle)}`
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.channelId) return data.channelId;
    }
  } catch {}

  return null;
}

// Fetch and parse YouTube RSS feed for a channel
export async function fetchChannelFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const resp = await fetchWithTimeout(feedUrl);
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
}

// Get channel avatar via our Cloudflare Worker proxy (YouTube Data API v3)
export async function fetchChannelAvatar(channelId, handle = null) {
  try {
    const resp = await fetchWithTimeout(
      `${RESOLVER_URL}?channelId=${encodeURIComponent(channelId)}`
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.avatar) return data.avatar;
    }
  } catch {}

  return null;
}

// Community posts — currently disabled (was using undocumented innertube API)
// TODO: Add community posts via YouTube Data API v3 (search.list or activities.list)
// if this feature is needed for monetisation. Requires extending the Worker proxy.
export async function fetchCommunityPosts(channelId) {
  return [];
}

// Check all channels for new content
export async function checkAllChannels(channels, includeCommunityPosts = false) {
  const results = [];

  for (const ch of channels) {
    try {
      let channelId = ch.channelId;
      if (!channelId) {
        channelId = await resolveChannelId(ch.handle);
        if (!channelId) {
          results.push({ ...ch, error: 'Could not resolve channel ID' });
          continue;
        }
      }

      const { channel, videos } = await fetchChannelFeed(channelId);

      // Fetch avatar — try @handle URL first (most reliable), fall back to channelId URL
      let avatar = null;
      try {
        avatar = await fetchChannelAvatar(channelId, ch.handle);
      } catch {
        // Avatar is non-critical
      }

      // Optionally fetch community posts
      let latestPost = null;
      if (includeCommunityPosts) {
        try {
          const posts = await fetchCommunityPosts(channelId);
          latestPost = posts[0] || null;
        } catch {
          // Non-critical
        }
      }

      results.push({
        ...ch,
        channelId,
        name: channel?.name || ch.name || ch.handle,
        avatar,
        videos: videos.slice(0, 5),
        latestVideo: videos[0] || null,
        latestPost,
        error: null,
      });
    } catch (err) {
      results.push({ ...ch, error: err.message });
    }
  }

  return results;
}
