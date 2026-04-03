import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// Resolve @handle to channel ID by scraping the channel page
export async function resolveChannelId(handle) {
  const url = `https://www.youtube.com/@${handle}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const html = await resp.text();

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

// Get channel profile picture URL from YouTube page
// og:image returns the banner, not the avatar. We need to scrape ytInitialData for the actual pfp.
export async function fetchChannelAvatar(handle) {
  try {
    const url = `https://www.youtube.com/@${handle}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await resp.text();

    // Look for avatar in ytInitialData — it's under "avatar" > "thumbnails"
    const avatarMatch = html.match(/"avatar"\s*:\s*\{\s*"decoratedAvatarViewModel"[^}]*"avatar"\s*:\s*\{\s*"avatarViewModel"[^}]*"image"\s*:\s*\{\s*"sources"\s*:\s*\[\s*\{\s*"url"\s*:\s*"([^"]+)"/);
    if (avatarMatch) return avatarMatch[1];

    // Fallback: look for thumbnail pattern in avatar context
    const thumbMatch = html.match(/"avatar"\s*:\s*\{[^}]*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
    if (thumbMatch) return thumbMatch[1];

    // Fallback: find any 88x88 yt image URL (typical avatar size)
    const smallAvatarMatch = html.match(/(https:\/\/yt3\.googleusercontent\.com\/[^"]+?=s88[^"]*)/);
    if (smallAvatarMatch) return smallAvatarMatch[1].replace('=s88', '=s176');

    // Last resort: any yt3.googleusercontent avatar-sized URL
    const anyAvatarMatch = html.match(/(https:\/\/yt3\.googleusercontent\.com\/[a-zA-Z0-9_-]{20,}[^"]*)/);
    if (anyAvatarMatch) return anyAvatarMatch[1];

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
