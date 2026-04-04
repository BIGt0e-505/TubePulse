import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// Common headers to bypass YouTube's consent wall (EU/UK cookie consent redirect)
const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Cookie': 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2MTcxNTcyNjAaAmVuIAEaBgiA_LyaBg',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Fetch with a timeout so the app never hangs
function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Resolve @handle to channel ID via YouTube's internal API (no consent wall)
export async function resolveChannelId(handle) {
  // Method 1: YouTube's navigation/resolve_url API — most reliable, no consent wall
  try {
    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/navigation/resolve_url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: '2.20240101' },
        },
        url: `https://www.youtube.com/@${handle}`,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      const str = JSON.stringify(data);
      const idMatch = str.match(/"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
      if (idMatch) return idMatch[1];
      const chanMatch = str.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
      if (chanMatch) return chanMatch[1];
    }
  } catch {}

  // Method 2: Scrape the channel page (fallback)
  try {
    const url = `https://www.youtube.com/@${handle}`;
    const resp = await fetchWithTimeout(url, {
      headers: YT_HEADERS,
      redirect: 'follow',
    });
    const html = await resp.text();

    const rssMatch = html.match(/channel_id=([a-zA-Z0-9_-]{24})/);
    if (rssMatch) return rssMatch[1];

    const chanMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
    if (chanMatch) return chanMatch[1];

    const canonMatch = html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (canonMatch) return canonMatch[1];
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

// Get channel profile picture URL by parsing ytInitialData from the channel page
export async function fetchChannelAvatar(channelId) {
  try {
    const url = `https://www.youtube.com/channel/${channelId}`;
    const resp = await fetchWithTimeout(url, {
      headers: YT_HEADERS,
      redirect: 'follow',
    });
    const html = await resp.text();

    // Extract ytInitialData JSON blob — contains structured channel metadata
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        // Navigate to avatar thumbnails in the channel header
        const header = data?.header?.c4TabbedHeaderRenderer
          || data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;

        if (header) {
          // c4TabbedHeaderRenderer path (most common)
          const thumbs = header.avatar?.thumbnails;
          if (thumbs?.length) {
            return thumbs[thumbs.length - 1].url;
          }
          // pageHeaderRenderer path (newer layout)
          const imgSources = header.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources;
          if (imgSources?.length) {
            return imgSources[imgSources.length - 1].url;
          }
        }
      } catch {
        // JSON parse failed, fall through to regex
      }
    }

    // Fallback: regex match for yt3 avatar URLs
    const ggphtMatch = html.match(/(https:\/\/yt3\.ggpht\.com\/[^"\\]+)/);
    if (ggphtMatch) return ggphtMatch[1];

    const guMatch = html.match(/(https:\/\/yt3\.googleusercontent\.com\/[^"\\]+)/);
    if (guMatch) return guMatch[1];

    return null;
  } catch {
    return null;
  }
}

// Check all channels for new content
export async function checkAllChannels(channels) {
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

      // Fetch avatar using channelId URL (bypasses consent wall)
      let avatar = null;
      try {
        avatar = await fetchChannelAvatar(channelId);
      } catch {
        // Avatar is non-critical
      }

      results.push({
        ...ch,
        channelId,
        name: channel?.name || ch.name || ch.handle,
        avatar,
        videos: videos.slice(0, 5),
        latestVideo: videos[0] || null,
        error: null,
      });
    } catch (err) {
      results.push({ ...ch, error: err.message });
    }
  }

  return results;
}
