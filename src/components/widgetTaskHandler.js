import React from 'react';
import { Linking } from 'react-native';
import { TubePulseWidget } from './TubePulseWidget';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from '../utils/storage';
import { fetchFeed, getDeviceId } from '../utils/api';

const nameToWidget = {
  TubePulseWidget: TubePulseWidget,
};

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

async function buildWidgetData(fetchFresh = false) {
  try {
    const [channels, settings, lastSeen, cache] = await Promise.all([
      getChannels(),
      getSettings(),
      getLastSeen(),
      getChannelCache(),
    ]);

    let activeCache = cache;

    // If cache is empty or a fresh fetch is requested, pull from server.
    // We also fetch fresh on WIDGET_UPDATE because the FCM background
    // handler may have updated the cache but the server may have even
    // newer data (e.g. engagement metrics, a second new video that
    // arrived between the push and the widget render).
    const cacheEmpty = Object.keys(cache).length === 0;
    if ((cacheEmpty || fetchFresh) && channels.length > 0) {
      try {
        const deviceId = await getDeviceId();
        if (deviceId) {
          const result = await fetchFeed(deviceId);
          if (result.ok && Array.isArray(result.channels)) {
            const newCache = {};
            const channelById = Object.fromEntries(
              channels.filter(c => c.channelId).map(c => [c.channelId, c])
            );
            for (const feed of result.channels) {
              const local = channelById[feed.channelId];
              const handle = local?.handle;
              if (!handle) continue;
              newCache[handle] = {
                name: feed.meta?.name || local?.name || handle,
                avatar: feed.meta?.avatarUrl || null,
                videos: feed.videos || [],
                posts: feed.posts || [],
                latestVideo: feed.videos?.[0] || null,
                channelId: feed.channelId,
                lastChecked: new Date().toISOString(),
              };
            }
            // Preserve any local-only channels that weren't in the server response
            for (const ch of channels) {
              if (!newCache[ch.handle] && cache[ch.handle]) {
                newCache[ch.handle] = cache[ch.handle];
              }
            }
            if (Object.keys(newCache).length > 0) {
              await saveChannelCache(newCache);
              activeCache = newCache;
            }
          }
        }
      } catch {
        // Network failed — fall through to whatever cache we have
      }
    }

    // Build widget channel data with videos and posts
    const widgetChannels = channels.map((ch) => {
      const cached = activeCache[ch.handle];
      const seenIds = lastSeen[ch.handle]?.seenIds || [];

      // All videos sorted newest-first
      let allVideos = cached?.videos?.length ? cached.videos : (cached?.latestVideo ? [cached.latestVideo] : []);
      allVideos = [...allVideos].sort((a, b) => new Date(b.publishedAt || b.published) - new Date(a.publishedAt || a.published));

      // All posts sorted newest-first
      let allPosts = cached?.posts?.length ? cached.posts : [];
      allPosts = [...allPosts].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      // Unseen videos
      const unseenVideos = allVideos.filter(v => !seenIds.includes(v.videoId));
      // Unseen posts (post IDs are namespaced with post: in seenIds,
      // matching the app's convention)
      const unseenPosts = allPosts.filter(p => !seenIds.includes(`post:${p.activityId}`));

      const unseenCount = unseenVideos.length + unseenPosts.length;
      const hasNew = unseenCount > 0;

      // Build video rows — show only the latest video (matching the
      // bootstrap behaviour of 1 video per channel). Seen videos
      // are dimmed; only genuinely new uploads appear as "New".
      const videoRows = allVideos.slice(0, 1).map((v) => {
        const isSeen = seenIds.includes(v.videoId);
        return {
          videoId: v.videoId,
          title: v.title,
          thumbnail: v.thumbnail,
          link: v.link,
          timeAgo: v.publishedAt ? timeAgo(v.publishedAt) : (v.published ? timeAgo(v.published) : ''),
          views: v.views || '',
          seen: isSeen,
          handle: ch.handle,
          kind: 'video',
        };
      });

      // Build post rows — show only the latest post (if any)
      const postRows = allPosts.slice(0, 1).map((p) => {
        const isSeen = seenIds.includes(`post:${p.activityId}`);
        return {
          postId: p.activityId,
          kind: p.kind || 'text',
          text: p.text || '',
          thumbnail: p.thumbnail || null,
          link: p.link || '',
          publishedAt: p.publishedAt || '',
          timeAgo: p.publishedAt ? timeAgo(p.publishedAt) : '',
          seen: isSeen,
          handle: ch.handle,
          type: 'post',
        };
      });

      return {
        handle: ch.handle,
        name: cached?.name || ch.name || ch.handle,
        avatar: cached?.avatar || null,
        channelId: cached?.channelId || ch.channelId || null,
        hasNew,
        unseenCount,
        tapAction: settings.tapAction || 'video',
        videos: videoRows,
        posts: postRows,
      };
    });

    return { channels: widgetChannels };
  } catch {
    return { channels: [] };
  }
}

// Helper: mark all videos + posts as seen for a channel
async function markAllSeen(handle) {
  const cache = await getChannelCache();
  const lastSeen = await getLastSeen();
  const allVideos = cache[handle]?.videos || (cache[handle]?.latestVideo ? [cache[handle].latestVideo] : []);
  const allPosts = cache[handle]?.posts || [];
  const videoIds = allVideos.map(v => v.videoId);
  const postIds = allPosts.map(p => `post:${p.activityId}`);
  const existing = lastSeen[handle]?.seenIds || [];
  lastSeen[handle] = { seenIds: [...new Set([...existing, ...videoIds, ...postIds])] };
  await saveLastSeen(lastSeen);
}

export async function widgetTaskHandler(props) {
  const widgetInfo = props.widgetInfo;
  const Widget = nameToWidget[widgetInfo.widgetName];

  if (!Widget) {
    props.renderWidget(<TubePulseWidget channels={[]} />);
    return;
  }

  switch (props.widgetAction) {
    case 'WIDGET_ADDED': {
      const data = await buildWidgetData(true);
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      // Always fetch fresh on WIDGET_UPDATE — the FCM push told us
      // something changed, so reading stale cache defeats the purpose.
      const data = await buildWidgetData(true);
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_CLICK': {
      // All custom click actions arrive as widgetAction='WIDGET_CLICK'.
      // The specific action name is in props.clickAction, and its
      // data is in props.clickActionData.
      const action = props.clickAction;
      const clickData = props.clickActionData || {};

      if (action === 'CHANNEL_MARK_ALL_CLICK') {
        // Avatar, channel header, or video row when tapAction='channel':
        // mark ALL videos + posts seen, then open channel.
        if (clickData.handle) {
          try {
            await markAllSeen(clickData.handle);
            await Linking.openURL(`https://www.youtube.com/@${clickData.handle}`);
          } catch {}
        }
      } else if (action === 'POST_CLICK') {
        // Post tap — mark just this post seen, open community tab.
        if (clickData.postId && clickData.handle) {
          try {
            const lastSeen = await getLastSeen();
            const seenIds = lastSeen[clickData.handle]?.seenIds || [];
            const postKey = `post:${clickData.postId}`;
            if (!seenIds.includes(postKey)) {
              lastSeen[clickData.handle] = { seenIds: [...seenIds, postKey] };
              await saveLastSeen(lastSeen);
            }
            await Linking.openURL(`https://www.youtube.com/@${clickData.handle}/community`);
          } catch {}
        }
      } else if (action === 'WIDGET_CLICK') {
        // Video row tap when tapAction='video' (default):
        // mark just this video seen, open the video.
        if (clickData.videoId && clickData.handle) {
          try {
            const lastSeen = await getLastSeen();
            const seenIds = lastSeen[clickData.handle]?.seenIds || [];
            if (!seenIds.includes(clickData.videoId)) {
              lastSeen[clickData.handle] = { seenIds: [...seenIds, clickData.videoId] };
              await saveLastSeen(lastSeen);
            }
            if (clickData.link) await Linking.openURL(clickData.link);
          } catch {}
        }
      }

      const data = await buildWidgetData();
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_DELETED':
      return;
    default:
      props.renderWidget(<TubePulseWidget channels={[]} />);
      return;
  }
}