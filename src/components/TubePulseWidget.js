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

const AVATAR_SIZE = 48;
const THUMB_HEIGHT = 48;
const THUMB_WIDTH = Math.round(THUMB_HEIGHT * (16 / 9));

function VideoRow({ video, seen, avatar, handle }) {
  const textColor = seen ? COLORS.textDim : COLORS.text;
  const titleWeight = seen ? 'normal' : 'bold';

  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 12,
        paddingVertical: 5,
      }}
    >
      {/* Avatar stub — tapping always opens channel */}
      <FlexWidget
        clickAction="CHANNEL_CLICK"
        clickActionData={{ handle }}
        style={{
          width: AVATAR_SIZE + 12, // 6px padding each side
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {avatar ? (
          <ImageWidget
            image={avatar}
            imageWidth={AVATAR_SIZE}
            imageHeight={AVATAR_SIZE}
            radius={AVATAR_SIZE / 2}
          />
        ) : (
          <FlexWidget
            style={{
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              borderRadius: AVATAR_SIZE / 2,
              backgroundColor: COLORS.surface,
            }}
          />
        )}
      </FlexWidget>

      {/* Video content — tapping opens video (or channel per settings) */}
      <FlexWidget
        clickAction="WIDGET_CLICK"
        clickActionData={{ videoId: video.videoId, link: video.link, handle }}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
      >
        {/* Thumbnail */}
        {video.thumbnail ? (
          <ImageWidget
            image={video.thumbnail}
            imageWidth={THUMB_WIDTH}
            imageHeight={THUMB_HEIGHT}
            radius={4}
          />
        ) : (
          <FlexWidget
            style={{
              width: THUMB_WIDTH,
              height: THUMB_HEIGHT,
              borderRadius: 4,
              backgroundColor: COLORS.surface,
            }}
          />
        )}

        {/* Title + meta */}
        <FlexWidget style={{ flex: 1, marginLeft: 8 }}>
          <TextWidget
            text={video.title || 'Untitled'}
            style={{ fontSize: 12, color: textColor, fontWeight: titleWeight }}
            maxLines={2}
          />
          {video.timeAgo ? (
            <TextWidget
              text={video.timeAgo}
              style={{ fontSize: 10, color: COLORS.textDim, marginTop: 2 }}
            />
          ) : null}
        </FlexWidget>

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
    </FlexWidget>
  );
}

function ChannelSection({ channel }) {
  return (
    <FlexWidget style={{ marginTop: 2 }}>
      {channel.videos.map((v) => (
        <VideoRow
          key={v.videoId}
          video={v}
          seen={v.seen}
          avatar={channel.avatar}
          handle={channel.handle}
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
