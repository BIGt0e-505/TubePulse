import React from 'react';
import {
  FlexWidget,
  TextWidget,
  ImageWidget,
} from 'react-native-android-widget';

const COLORS = {
  bg: 'rgba(13, 13, 13, 0.85)',
  surface: '#1A1A1A',
  text: '#E0E0E0',
  textDim: '#666666',
  accent: '#4FC3F7',
  white: '#FFFFFF',
};

function VideoRow({ video, seen, tapAction }) {
  const textColor = seen ? COLORS.textDim : COLORS.text;
  const titleWeight = seen ? 'normal' : 'bold';

  return (
    <FlexWidget
      clickAction="WIDGET_CLICK"
      clickActionData={{ videoId: video.videoId, link: video.link, handle: video.handle }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      {/* Thumbnail */}
      {video.thumbnail ? (
        <ImageWidget
          image={video.thumbnail}
          imageWidth={64}
          imageHeight={36}
          radius={4}
        />
      ) : (
        <FlexWidget
          style={{
            width: 64,
            height: 36,
            borderRadius: 4,
            backgroundColor: COLORS.surface,
          }}
        />
      )}

      {/* Title */}
      <FlexWidget style={{ flex: 1, marginLeft: 8 }}>
        <TextWidget
          text={video.title || 'Untitled'}
          style={{ fontSize: 12, color: textColor, fontWeight: titleWeight }}
          maxLines={2}
        />
      </FlexWidget>

      {/* Age */}
      {video.timeAgo ? (
        <TextWidget
          text={video.timeAgo}
          style={{ fontSize: 10, color: COLORS.textDim, marginLeft: 6 }}
        />
      ) : null}

      {/* New dot */}
      {!seen ? (
        <FlexWidget
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: COLORS.accent,
            marginLeft: 6,
          }}
        />
      ) : null}
    </FlexWidget>
  );
}

function ChannelSection({ channel }) {
  return (
    <FlexWidget style={{ marginTop: 2 }}>
      {/* Channel header */}
      <FlexWidget style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
        <TextWidget
          text={`@${channel.handle}`}
          style={{
            fontSize: 12,
            color: channel.hasNew ? COLORS.accent : COLORS.textDim,
            fontWeight: channel.hasNew ? 'bold' : 'normal',
          }}
          maxLines={1}
        />
      </FlexWidget>

      {/* Video rows */}
      {channel.videos.map((v) => (
        <VideoRow
          key={v.videoId}
          video={v}
          seen={v.seen}
          tapAction={channel.tapAction}
        />
      ))}
    </FlexWidget>
  );
}

export function TubePulseWidget({ channels = [] }) {
  return (
    <FlexWidget
      style={{
        flex: 1,
        width: 'match_parent',
        backgroundColor: COLORS.bg,
        borderRadius: 16,
        paddingVertical: 4,
      }}
    >
      {/* Header */}
      <FlexWidget
        clickAction="OPEN_APP"
        style={{
          flexDirection: 'row',
          paddingHorizontal: 14,
          paddingVertical: 6,
          width: 'match_parent',
        }}
      >
        <TextWidget
          text="TubePulse"
          style={{
            fontSize: 13,
            color: COLORS.accent,
            fontWeight: 'bold',
          }}
        />
      </FlexWidget>

      {/* Channel sections */}
      {channels.length === 0 ? (
        <FlexWidget style={{ padding: 14 }}>
          <TextWidget
            text="Open app to load channels"
            style={{ fontSize: 12, color: COLORS.textDim }}
          />
        </FlexWidget>
      ) : (
        channels.map((ch) => (
          <ChannelSection key={ch.handle} channel={ch} />
        ))
      )}
    </FlexWidget>
  );
}
