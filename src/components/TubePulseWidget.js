import React from 'react';
import {
  FlexWidget,
  TextWidget,
  ImageWidget,
  ListWidget,
  ClickAction,
} from 'react-native-android-widget';

const COLORS = {
  bg: 'rgba(13, 13, 13, 0.85)',
  surface: '#1A1A1A',
  text: '#E0E0E0',
  textDim: '#666666',
  accent: '#4FC3F7',
};

function ChannelRow({ channel, isNew, tapUrl }) {
  const nameColor = isNew ? COLORS.text : COLORS.textDim;
  const titleColor = isNew ? COLORS.text : COLORS.textDim;

  return (
    <ClickAction action="OPEN_URL" data={tapUrl}>
      <FlexWidget
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        {/* Avatar */}
        {channel.avatar ? (
          <ImageWidget
            image={channel.avatar}
            imageWidth={32}
            imageHeight={32}
            radius={16}
          />
        ) : (
          <FlexWidget
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: COLORS.surface,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <TextWidget
              text={(channel.name || '?').charAt(0).toUpperCase()}
              style={{ fontSize: 14, color: COLORS.textDim }}
            />
          </FlexWidget>
        )}

        {/* Channel info */}
        <FlexWidget style={{ flex: 1, marginLeft: 10 }}>
          <FlexWidget style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <TextWidget
              text={channel.name || channel.handle}
              style={{ fontSize: 13, color: nameColor, fontWeight: isNew ? 'bold' : 'normal' }}
              maxLines={1}
            />
            {channel.timeAgo ? (
              <TextWidget
                text={channel.timeAgo}
                style={{ fontSize: 11, color: COLORS.textDim }}
              />
            ) : null}
          </FlexWidget>
          <TextWidget
            text={channel.videoTitle || 'No new videos'}
            style={{ fontSize: 12, color: titleColor, marginTop: 1 }}
            maxLines={1}
          />
        </FlexWidget>

        {/* New dot */}
        {isNew && (
          <FlexWidget
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: COLORS.accent,
              marginLeft: 8,
            }}
          />
        )}
      </FlexWidget>
    </ClickAction>
  );
}

export function TubePulseWidget({ channels = [], settings = {} }) {
  return (
    <FlexWidget
      style={{
        flex: 1,
        backgroundColor: COLORS.bg,
        borderRadius: 16,
        paddingVertical: 6,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <ClickAction action="OPEN_APP">
        <FlexWidget
          style={{
            paddingHorizontal: 14,
            paddingVertical: 6,
          }}
        >
          <TextWidget
            text="TubePulse"
            style={{
              fontSize: 13,
              color: COLORS.accent,
              fontWeight: 'bold',
              letterSpacing: 0.5,
            }}
          />
        </FlexWidget>
      </ClickAction>

      {/* Channel list */}
      {channels.length === 0 ? (
        <FlexWidget style={{ padding: 14 }}>
          <TextWidget
            text="Pull down to refresh"
            style={{ fontSize: 12, color: COLORS.textDim }}
          />
        </FlexWidget>
      ) : (
        channels.map((ch, i) => (
          <ChannelRow
            key={ch.handle || i}
            channel={ch}
            isNew={ch.isNew}
            tapUrl={
              settings.tapAction === 'channel'
                ? `https://www.youtube.com/@${ch.handle}`
                : ch.videoLink || `https://www.youtube.com/@${ch.handle}`
            }
          />
        ))
      )}
    </FlexWidget>
  );
}
