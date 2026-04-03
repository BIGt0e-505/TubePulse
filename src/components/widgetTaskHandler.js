import React from 'react';
import { TubePulseWidget } from './TubePulseWidget';
import { getChannels, getSettings, getLastSeen, getChannelCache } from '../utils/storage';

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

async function buildWidgetData() {
  const [channels, settings, lastSeen, cache] = await Promise.all([
    getChannels(),
    getSettings(),
    getLastSeen(),
    getChannelCache(),
  ]);

  const widgetChannels = channels.map((ch) => {
    const cached = cache[ch.handle];
    const ls = lastSeen[ch.handle];
    const isNew = ls && !ls.seen;

    return {
      handle: ch.handle,
      name: cached?.name || ch.name || ch.handle,
      avatar: cached?.avatar || null,
      videoTitle: cached?.latestVideo?.title || null,
      videoLink: cached?.latestVideo?.link || null,
      timeAgo: cached?.latestVideo?.published ? timeAgo(cached.latestVideo.published) : '',
      isNew: !!isNew,
    };
  });

  return { channels: widgetChannels, settings };
}

export async function widgetTaskHandler(props) {
  const widgetInfo = props.widgetInfo;
  const Widget = nameToWidget[widgetInfo.widgetName];

  if (!Widget) {
    return (
      <TubePulseWidget channels={[]} settings={{}} />
    );
  }

  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      const data = await buildWidgetData();
      return <Widget {...data} />;
    }
    case 'WIDGET_CLICK': {
      // Handle click actions — OPEN_URL and OPEN_APP are handled by the library
      const data = await buildWidgetData();
      return <Widget {...data} />;
    }
    default:
      return <TubePulseWidget channels={[]} settings={{}} />;
  }
}
