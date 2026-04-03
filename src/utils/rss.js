import { parseString } from 'react-native-xml2js';

// Resolve @handle to channel ID by scraping the channel page
export async function resolveChannelId(handle) {
  const url = `https://www.youtube.com/@${handle}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const html = await resp.text();

  // Look for channel ID in meta tags or page data
  const match = html.match(/channel_id=([a-zA-Z0-9_-]{24})/);
  if (match) return match[1];

  const match2 = html.match(/"channelId"\s*:\s*"([a-zA-Z0-9_-]{24})"/);
  if (match2) return match2[1];

  return null;
}

// Fetch and parse YouTube RSS feed for a channel
export async function fetchChannelFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const resp = await fetch(feedUrl);
  const xml = await resp.text();

  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: false }, (err, result) => {
      if (err) return reject(err);

      const feed = result.feed;
      if (!feed || !feed.entry) return resolve({ channel: null, videos: [] });

      const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

      const channel = {
        name: feed.author?.name || feed.title || '',
        uri: feed.author?.uri || '',
        profileUrl: null, // RSS doesn't include pfp, we'll get it separately
      };

      const videos = entries.map((entry) => ({
        videoId: entry['yt:videoId'],
        title: entry.title,
        published: entry.published,
        updated: entry.updated,
        link: entry.link?.$?.href || `https://www.youtube.com/watch?v=${entry['yt:videoId']}`,
        thumbnail: entry['media:group']?.['media:thumbnail']?.$?.url || null,
        description: entry['media:group']?.['media:description'] || '',
        views: entry['media:group']?.['media:community']?.['media:statistics']?.$?.views || '0',
      }));

      resolve({ channel, videos });
    });
  });
}

// Get channel profile picture URL from YouTube page
export async function fetchChannelAvatar(handle) {
  try {
    const url = `https://www.youtube.com/@${handle}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await resp.text();

    // YouTube embeds avatar in og:image or in yt initial data
    const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    if (ogMatch) return ogMatch[1];

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
      const avatar = await fetchChannelAvatar(ch.handle);

      results.push({
        ...ch,
        channelId,
        name: channel?.name || ch.name || ch.handle,
        avatar,
        videos,
        latestVideo: videos[0] || null,
        error: null,
      });
    } catch (err) {
      results.push({ ...ch, error: err.message });
    }
  }

  return results;
}
