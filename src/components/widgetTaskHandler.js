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
          // First time seeing channel in widget — mark all seen (clean slate)
          if (!updatedLastSeen[r.handle]) {
            const allIds = (r.videos?.length ? r.videos : [r.latestVideo]).map(v => v.videoId);
            updatedLastSeen[r.handle] = { seenIds: allIds };
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
      const seenIds = lastSeen[ch.handle]?.seenIds || [];

      // All videos sorted newest-first
      let allVideos = cached?.videos?.length ? cached.videos : (cached?.latestVideo ? [cached.latestVideo] : []);
      allVideos = [...allVideos].sort((a, b) => new Date(b.published) - new Date(a.published));

      // Unseen count
      const unseenVideos = allVideos.filter(v => !seenIds.includes(v.videoId));
      const unseenCount = unseenVideos.length;

      // Current video = oldest unseen, or latest if all seen
      const currentVideo = unseenVideos.length > 0
        ? unseenVideos[unseenVideos.length - 1]
        : allVideos[0] || null;

      const hasNew = unseenCount > 0;

      const videoRows = currentVideo ? [{
        videoId: currentVideo.videoId,
        title: currentVideo.title,
        thumbnail: currentVideo.thumbnail,
        link: currentVideo.link,
        timeAgo: currentVideo.published ? timeAgo(currentVideo.published) : '',
        seen: !hasNew,
        handle: ch.handle,
      }] : [];

      return {
        handle: ch.handle,
        name: cached?.name || ch.name || ch.handle,
        avatar: cached?.avatar || null,
        channelId: cached?.channelId || ch.channelId || null,
        hasNew,
        unseenCount,
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
      // Mark ALL videos seen, then open channel
      const { handle } = props.clickActionData || {};
      if (handle) {
        try {
          const cache = await getChannelCache();
          const lastSeen = await getLastSeen();
          const allVideos = cache[handle]?.videos || (cache[handle]?.latestVideo ? [cache[handle].latestVideo] : []);
          const allIds = allVideos.map(v => v.videoId);
          const existing = lastSeen[handle]?.seenIds || [];
          lastSeen[handle] = { seenIds: [...new Set([...existing, ...allIds])] };
          await saveLastSeen(lastSeen);
          await Linking.openURL(`https://www.youtube.com/@${handle}`);
        } catch {}
      }
      const data = await buildWidgetData();
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_CLICK': {
      const clickData = props.clickActionData;
      const settings = await getSettings();

      if (settings.tapAction === 'channel' && clickData?.handle) {
        // Mark all seen, open channel
        try {
          const cache = await getChannelCache();
          const lastSeen = await getLastSeen();
          const allVideos = cache[clickData.handle]?.videos || (cache[clickData.handle]?.latestVideo ? [cache[clickData.handle].latestVideo] : []);
          const allIds = allVideos.map(v => v.videoId);
          const existing = lastSeen[clickData.handle]?.seenIds || [];
          lastSeen[clickData.handle] = { seenIds: [...new Set([...existing, ...allIds])] };
          await saveLastSeen(lastSeen);
          await Linking.openURL(`https://www.youtube.com/@${clickData.handle}`);
        } catch {}
      } else if (clickData?.videoId && clickData?.handle) {
        // Mark this video seen, open it
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
