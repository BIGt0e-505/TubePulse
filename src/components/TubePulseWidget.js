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

function formatViews(views) {
  const n = parseInt(views, 10);
  if (isNaN(n) || n === 0) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${n} views`;
}

function VideoRow({ video, seen, avatar, handle, tapAction }) {
  const textColor = seen ? COLORS.textDim : COLORS.text;
  const titleWeight = seen ? 'normal' : 'bold';

  // When tapAction is 'channel', the video row tap does what a
  // channel tap does: mark all seen + open channel. When 'video'
  // (default), it marks just this video seen + opens the video.
  const videoClickAction = tapAction === 'channel' ? 'CHANNEL_MARK_ALL_CLICK' : 'WIDGET_CLICK';
  const videoClickData = tapAction === 'channel'
    ? { handle }
    : { videoId: video.videoId, link: video.link, handle };

  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 12,
        paddingVertical: 5,
        width: 'match_parent',
      }}
    >
      {/* Avatar / pfp — tapping ALWAYS opens channel + marks all seen,
          regardless of tapAction. This matches the app's
          handleChannelOpen on avatar tap. */}
      <FlexWidget
        clickAction="CHANNEL_MARK_ALL_CLICK"
        clickActionData={{ handle }}
        style={{
          width: AVATAR_SIZE + 12,
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
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <TextWidget
              text={handle ? handle.charAt(0).toUpperCase() : '?'}
              style={{ fontSize: 32, color: COLORS.textDim, fontWeight: 'bold' }}
            />
          </FlexWidget>
        )}
      </FlexWidget>

      {/* Thumbnail + title — behaviour depends on tapAction:
          - 'video' (default): opens the video, marks just this video seen
          - 'channel': opens the channel, marks all seen */}
      <FlexWidget
        clickAction={videoClickAction}
        clickActionData={videoClickData}
        style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
      >
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

        {/* Title and meta below */}
        <FlexWidget style={{ flex: 1, marginLeft: 8, flexDirection: 'column' }}>
          <TextWidget
            text={video.title || 'Untitled'}
            style={{ fontSize: 12, color: textColor, fontWeight: titleWeight }}
            maxLines={2}
          />
          {(video.timeAgo || video.views) && (
            <FlexWidget
              style={{
                flexDirection: 'row',
                width: 'match_parent',
                marginTop: 2,
              }}
            >
              {video.timeAgo ? (
                <TextWidget
                  text={video.timeAgo}
                  style={{ fontSize: 10, color: COLORS.textDim }}
                />
              ) : null}
              {video.views && video.views !== '0' ? (
                <FlexWidget
                  style={{
                    flex: 1,
                    alignItems: 'flex-end',
                  }}
                >
                  <TextWidget
                    text={formatViews(video.views)}
                    style={{ fontSize: 10, color: COLORS.textDim, textAlign: 'right' }}
                  />
                </FlexWidget>
              ) : null}
            </FlexWidget>
          )}
        </FlexWidget>
      </FlexWidget>
    </FlexWidget>
  );
}

function PostRow({ post, avatar, handle }) {
  const textColor = post.seen ? COLORS.textDim : COLORS.text;
  const titleWeight = post.seen ? 'normal' : 'bold';

  let label = 'Posted';
  if (post.kind === 'image') label = 'Posted an image';
  else if (post.kind === 'poll') label = 'Posted a poll';

  const truncatedText = post.text ? (post.text.length > 120 ? post.text.substring(0, 117) + '...' : post.text) : '';

  return (
    <FlexWidget
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 12,
        paddingVertical: 5,
        width: 'match_parent',
      }}
    >
      {/* Avatar — same as video row, always channel + mark all */}
      <FlexWidget
        clickAction="CHANNEL_MARK_ALL_CLICK"
        clickActionData={{ handle }}
        style={{
          width: AVATAR_SIZE + 12,
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
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <TextWidget
              text={handle ? handle.charAt(0).toUpperCase() : '?'}
              style={{ fontSize: 32, color: COLORS.textDim, fontWeight: 'bold' }}
            />
          </FlexWidget>
        )}
      </FlexWidget>

      {/* Post content — tapping always opens community tab + marks post seen.
          tapAction doesn't change post behaviour (same as the app). */}
      <FlexWidget
        clickAction="POST_CLICK"
        clickActionData={{ postId: post.postId, handle }}
        style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
      >
        {post.thumbnail ? (
          <ImageWidget
            image={post.thumbnail}
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
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <TextWidget
              text="💬"
              style={{ fontSize: 20, color: COLORS.textDim }}
            />
          </FlexWidget>
        )}

        <FlexWidget style={{ flex: 1, marginLeft: 8, flexDirection: 'column' }}>
          <TextWidget
            text={label}
            style={{ fontSize: 10, color: COLORS.textDim, fontWeight: titleWeight }}
            maxLines={1}
          />
          {truncatedText ? (
            <TextWidget
              text={truncatedText}
              style={{ fontSize: 11, color: textColor, marginTop: 1 }}
              maxLines={2}
            />
          ) : null}
          {post.timeAgo ? (
            <TextWidget
              text={post.timeAgo}
              style={{ fontSize: 10, color: COLORS.textDim, marginTop: 1 }}
            />
          ) : null}
        </FlexWidget>
      </FlexWidget>
    </FlexWidget>
  );
}

function ChannelSection({ channel }) {
  // Merge videos and posts into a single chronological list (newest first)
  const now = Date.now();
  const allItems = [
    ...channel.videos.map(v => ({
      ...v,
      _sort: v.publishedAt ? now - new Date(v.publishedAt).getTime() : (v.published ? now - new Date(v.published).getTime() : Infinity),
      _type: 'video',
    })),
    ...channel.posts.map(p => ({
      ...p,
      _sort: p.publishedAt ? now - new Date(p.publishedAt).getTime() : Infinity,
      _type: 'post',
    })),
  ].sort((a, b) => a._sort - b._sort);

  return (
    <FlexWidget style={{ marginTop: 2, width: 'match_parent' }}>
      {/* Channel header — opens channel + marks all seen.
          This matches the app's avatar/channel-name tap (handleChannelOpen),
          which always marks all + opens channel, regardless of tapAction. */}
      <FlexWidget
        clickAction="CHANNEL_MARK_ALL_CLICK"
        clickActionData={{ handle: channel.handle }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 4,
          width: 'match_parent',
        }}
      >
        <FlexWidget style={{ flex: 1 }}>
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
        <TextWidget
          text={channel.unseenCount > 0 ? `${channel.unseenCount} New` : '0 New'}
          style={{
            fontSize: 11,
            color: channel.unseenCount > 0 ? COLORS.accent : COLORS.textDim,
            fontWeight: channel.unseenCount > 0 ? 'bold' : 'normal',
          }}
        />
      </FlexWidget>

      {/* Mixed video + post rows, newest first */}
      {allItems.map((item, i) => {
        if (item._type === 'post') {
          return (
            <PostRow
              key={`post-${item.postId}-${i}`}
              post={item}
              avatar={channel.avatar}
              handle={channel.handle}
            />
          );
        }
        return (
          <VideoRow
            key={`video-${item.videoId}-${i}`}
            video={item}
            seen={item.seen}
            avatar={channel.avatar}
            handle={channel.handle}
            tapAction={channel.tapAction}
          />
        );
      })}
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
      {/* Header — opens the app */}
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