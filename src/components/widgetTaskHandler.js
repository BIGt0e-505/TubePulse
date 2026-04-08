import React from 'react';
import { Linking } from 'react-native';
import { TubePulseWidget } from './TubePulseWidget';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from '../utils/storage';
import { checkAllChannels } from '../utils/rss';

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

    // If cache is empty or a fresh fetch is requested, pull live data
    const cacheEmpty = Object.keys(cache).length === 0;
    if ((cacheEmpty || fetchFresh) && channels.length > 0) {
      try {
        const results = await checkAllChannels(channels);
        const newCache = {};
        const updatedLastSeen = { ...lastSeen };
        for (const r of results) {
          if (r.error || !r.latestVideo) continue;
          newCache[r.handle] = {
            name: r.name,
            avatar: r.avatar,
            videos: r.videos,
            latestVideo: r.latestVideo,
            channelId: r.channelId,
            lastChecked: new Date().toISOString(),
          };
          // Seed new channels with latest video already seen (lowlighted)
          if (!updatedLastSeen[r.handle]) {
            updatedLastSeen[r.handle] = { seenIds: [r.latestVideo.videoId] };
          }
        }
        if (Object.keys(newCache).length > 0) {
          await saveChannelCache(newCache);
          await saveLastSeen(updatedLastSeen);
          activeCache = newCache;
        }
      } catch {
        // Network failed — fall through to whatever cache we have
      }
    }

    // Build widget channel data with videos
    const widgetChannels = channels.map((ch) => {
      const cached = activeCache[ch.handle];
      const ls = lastSeen[ch.handle];
      const seenIds = ls?.seenIds || [];

      // Get videos from cache (up to 3 for widget space), fall back to latestVideo
      let videos = cached?.videos || [];
      if (videos.length === 0 && cached?.latestVideo) {
        videos = [cached.latestVideo];
      }
      // Show latest video only (1 per channel in widget to save space)
      videos = videos.slice(0, 1);

      const videoRows = videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnail: v.thumbnail,
        link: v.link,
        timeAgo: v.published ? timeAgo(v.published) : '',
        seen: seenIds.includes(v.videoId),
        handle: ch.handle,
      }));

      const hasNew = videoRows.some((v) => !v.seen);

      return {
        handle: ch.handle,
        name: cached?.name || ch.name || ch.handle,
        avatar: cached?.avatar || null,
        channelId: cached?.channelId || ch.channelId || null,
        hasNew,
        tapAction: settings.tapAction || 'video',
        videos: videoRows,
      };
    });

    return { channels: widgetChannels };
  } catch {
    return { channels: [] };
  }
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
      const data = await buildWidgetData();
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'CHANNEL_CLICK': {
      // Always open channel page regardless of tap settings
      const { handle } = props.clickActionData || {};
      if (handle) {
        try {
          await Linking.openURL(`https://www.youtube.com/@${handle}`);
        } catch {}
      }
      const data = await buildWidgetData();
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_CLICK': {
      // Mark video as seen and open the URL
      const clickData = props.clickActionData;
      if (clickData?.videoId && clickData?.handle) {
        try {
          const lastSeen = await getLastSeen();
          const ls = lastSeen[clickData.handle] || { seenIds: [] };
          const seenIds = ls.seenIds || [];
          if (!seenIds.includes(clickData.videoId)) {
            lastSeen[clickData.handle] = { seenIds: [...seenIds, clickData.videoId] };
            await saveLastSeen(lastSeen);
          }
        } catch {}
      }

      // Open the video or channel URL based on user's tap action setting
      try {
        const settings = await getSettings();
        const url = settings.tapAction === 'channel'
          ? `https://www.youtube.com/@${clickData.handle}`
          : clickData?.link;
        if (url) await Linking.openURL(url);
      } catch {}

      // Re-render widget with updated seen state
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
