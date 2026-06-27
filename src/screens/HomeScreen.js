import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
  StyleSheet,
  RefreshControl,
  Linking,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { SvgXml } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from '../utils/storage';
import { fetchFeed, markSeen, getDeviceId } from '../utils/api';

const THUMB_UP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 22V11" />
  <path d="M3 11h4v11H3z" />
  <path d="M7 11l4.5-8.5c.6-.1 1.2.1 1.6.5.4.5.5 1.1.4 1.7L12.5 9H20c.8 0 1.5.7 1.5 1.5l-1.5 9c-.1.7-.7 1.2-1.4 1.2H7" />
</svg>`;

const THUMB_DOWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 12 12)">
  <path d="M7 22V11" />
  <path d="M3 11h4v11H3z" />
  <path d="M7 11l4.5-8.5c.6-.1 1.2.1 1.6.5.4.5.5 1.1.4 1.7L12.5 9H20c.8 0 1.5.7 1.5 1.5l-1.5 9c-.1.7-.7 1.2-1.4 1.2H7" />
</svg>`;

export default function HomeScreen({ navigation }) {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [lastSeen, setLastSeen] = useState({});
  const [settings, setSettings] = useState({ tapAction: 'video' });
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  // Hold the latest cache in a ref so refresh() can be stable
  // (depending on `cache` directly caused an infinite re-render loop
  //  because setCache -> new refresh -> new useEffect -> new autoFetch -> new setCache)
  const cacheRef = useRef({});

  const loadData = useCallback(async () => {
    const [ch, s, ls, ca] = await Promise.all([
      getChannels(),
      getSettings(),
      getLastSeen(),
      getChannelCache(),
    ]);
    cacheRef.current = ca || {};
    setChannels(ch);
    setSettings(s);
    setLastSeen(ls);
    setCache(ca);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const deviceId = await getDeviceId();
      if (deviceId) {
        const result = await fetchFeed(deviceId);
        if (result.ok && result.channels) {
          // v3 /feed returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
          const [localChannels] = await Promise.all([getChannels()]);
          const newCache = {};

          for (const serverChannel of result.channels) {
            const ch = localChannels.find((c) => c.channelId === serverChannel.channelId);
            const handle = ch?.handle || serverChannel.channelId;

            // Build a lookup of existing local videos by id so we can fall
            // back to locally-cached views if the server response is missing
            // the field (e.g. for a server response that was prepared by an
            // older worker build, or any other transient gap).
            const existingByVideoId = new Map(
              ((cacheRef.current[handle] || {}).videos || []).map((v) => [v.videoId, v])
            );

            const videos = (serverChannel.videos || []).map((v) => ({
              videoId: v.videoId,
              title: v.title,
              published: v.publishedAt,
              thumbnail: v.thumbnail,
              link: v.link,
              type: v.type,
              unwatched: v.unwatched,
              views: v.views || existingByVideoId.get(v.videoId)?.views || '0',
              likes: v.likes ?? existingByVideoId.get(v.videoId)?.likes ?? 0,
              dislikes: v.dislikes ?? existingByVideoId.get(v.videoId)?.dislikes ?? 0,
            }));

            // Posts come from the server already filtered by the global +
            // per-channel override. Empty array when disabled or absent.
            const posts = serverChannel.posts || [];

            // Use the ref so this callback stays stable across renders
            const existingEntry = cacheRef.current[handle] || {};
            const localVideos = existingEntry.videos || [];
            // Use server data when available, preserve local-only channels
            const mergedVideos = videos.length >= localVideos.length ? videos : localVideos;

            newCache[handle] = {
              name: serverChannel.meta?.name || existingEntry.name,
              avatar: serverChannel.meta?.avatarUrl || existingEntry.avatar || null,
              videos: mergedVideos,
              posts,
              latestVideo: mergedVideos[0] || null,
              channelId: serverChannel.channelId,
              lastChecked: serverChannel.meta?.addedAt ? new Date(serverChannel.meta.addedAt).toISOString() : existingEntry.lastChecked,
            };
          }

          // Preserve channels that exist locally but weren't in server response
          for (const ch of localChannels) {
            if (!newCache[ch.handle] && cacheRef.current[ch.handle]) {
              newCache[ch.handle] = cacheRef.current[ch.handle];
            }
          }

          cacheRef.current = newCache;
          await saveChannelCache(newCache);
          setCache(newCache);

          // Update local lastSeen from server's unwatched data
          const lastSeen = await getLastSeen();
          for (const serverChannel of result.channels) {
            const ch = localChannels.find((c) => c.channelId === serverChannel.channelId);
            const handle = ch?.handle;
            if (!handle) continue;

            if (!lastSeen[handle]) lastSeen[handle] = { seenIds: [] };
            const seenIds = new Set(lastSeen[handle].seenIds || []);

            // Videos/posts NOT in unwatched are seen.
            for (const v of (serverChannel.videos || [])) {
              if (!v.unwatched && v.videoId) {
                seenIds.add(v.videoId);
              }
            }
            for (const p of (serverChannel.posts || [])) {
              if (!p.unwatched && p.activityId) {
                seenIds.add(`post:${p.activityId}`);
              }
            }
            lastSeen[handle].seenIds = [...seenIds];
          }
          await saveLastSeen(lastSeen);
          setLastSeen(lastSeen);
        }
      } else {
        const ca = await getChannelCache();
        cacheRef.current = ca;
        setCache(ca);
      }
    } catch (e) {
      console.warn('Refresh failed:', e);
      const ca = await getChannelCache();
      cacheRef.current = ca;
      setCache(ca);
    }
    setRefreshing(false);

    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  }, []); // stable: no deps, uses cacheRef

  const autoFetch = useCallback(async () => {
    const [ch] = await Promise.all([getChannels()]);
    // Wait for App.js init to finish (sets flag when done)
    const initDone = await AsyncStorage.getItem('tubepulse_init_done');
    if (!initDone) {
      // Poll until init completes (max 15s).
      // 500ms setTimeout calls don't trigger re-renders by themselves,
      // but the cacheRef updates + setState calls at the end of this
      // function do — and we now use stable callbacks (loadData, refresh)
      // so the only re-renders come from intentional state updates.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const done = await AsyncStorage.getItem('tubepulse_init_done');
        if (done) break;
      }
    }
    // Init has written cache data — re-read everything before refreshing
    const [freshChannels, freshCache, freshLastSeen, freshSettings] = await Promise.all([
      getChannels(),
      getChannelCache(),
      getLastSeen(),
      getSettings(),
    ]);
    cacheRef.current = freshCache || {};
    setChannels(freshChannels);
    setCache(freshCache);
    setLastSeen(freshLastSeen);
    setSettings(freshSettings);
    setLoading(false);

    // Now refresh from server (supplements local cache with live data)
    if (freshChannels.length > 0) {
      await refresh();
    }
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      loadData().then(() => refresh());
    }, [loadData, refresh])
  );

  useEffect(() => {
    autoFetch();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh();
        try {
          const { requestWidgetUpdate } = require('react-native-android-widget');
          requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
        } catch {}
      }
    });

    return () => sub.remove();
  }, [loadData, refresh, autoFetch]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const getVideos = (handle) => {
    const cached = cache[handle];
    if (!cached) return [];
    const vids = cached.videos?.length ? cached.videos : (cached.latestVideo ? [cached.latestVideo] : []);
    return [...vids].sort((a, b) => new Date(b.published) - new Date(a.published));
  };

  const getPosts = (handle) => {
    const cached = cache[handle];
    if (!cached || !cached.posts) return [];
    return [...cached.posts].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  };

  const getContentTimestampMs = (item, fields) => {
    for (const field of fields) {
      const value = item?.[field];
      if (!value) continue;
      const timestamp = new Date(value).getTime();
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
  };

  const chooseLatestChannelContent = (video, post) => {
    if (!video && !post) return null;
    if (!video) return post ? { type: 'post', item: post } : null;
    if (!post) return { type: 'video', item: video };

    const videoTime = getContentTimestampMs(video, ['published', 'publishedAt']);
    const postTime = getContentTimestampMs(post, ['publishedAt']);

    if (videoTime != null && postTime != null) {
      return postTime > videoTime
        ? { type: 'post', item: post }
        : { type: 'video', item: video };
    }
    if (videoTime != null) return { type: 'video', item: video };
    if (postTime != null) return { type: 'post', item: post };
    return { type: 'video', item: video };
  };

  const getPostSeenId = (post) => {
    if (!post) return null;
    if (post.id) return post.id;
    return post.activityId ? `post:${post.activityId}` : null;
  };

  const isPostUnwatched = (post) => post?.unwatched === true;

  const selectPersistentLatestContent = (handle) => {
    return chooseLatestChannelContent(getVideos(handle)[0] || null, getPosts(handle)[0] || null);
  };

  const getVisiblePosts = (handle) => {
    const posts = getPosts(handle);
    const latestVideo = getVideos(handle)[0] || null;
    const visibleUnseen = posts.filter((post) => (
      isPostUnwatched(post)
      && chooseLatestChannelContent(latestVideo, post)?.type === 'post'
    ));
    if (visibleUnseen.length > 0) return visibleUnseen;
    const persistent = selectPersistentLatestContent(handle);
    if (persistent?.type === 'post') return [persistent.item];
    return [];
  };

  const getUnseenVideos = (handle) => {
    // Source of truth: the server's `unwatched` flag on each video in
    // the cache (populated from the /feed response). The local
    // `seenIds` is a UI cache used elsewhere (e.g. to display the
    // "seen" dot), but it is NOT a reliable filter for unseen videos:
    //   - The loadData sync only ADDS to seenIds (for videos the
    //     server marks as seen), never REMOVES (when the server
    //     later un-sees one, e.g. a missed-tap re-add or a cron
    //     re-classification).
    //   - A previous markSeen for a videoId that's since been
    //     re-classified as unseen server-side would still be in the
    //     local seenIds and would hide the video.
    // Result: filtering by !seenIds.includes() silently drops videos
    // the user genuinely hasn't watched yet, making the home screen
    // fall back to [latestVideo] when seenIds happens to cover
    // everything.
    return getVideos(handle).filter(v => v.unwatched === true);
  };

  const unseenCount = (handle) => getUnseenVideos(handle).length;

  const getCurrentVideo = (handle) => {
    const unseen = getUnseenVideos(handle);
    if (unseen.length > 0) return unseen[unseen.length - 1];
    const persistent = selectPersistentLatestContent(handle);
    return persistent?.type === 'video' ? persistent.item : null;
  };

  const handleChannelOpen = async (channel) => {
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const allIds = getVideos(key).map(v => v.videoId);
    const allPostIds = getPosts(key).map(getPostSeenId).filter(Boolean);
    const existing = updatedLastSeen[key].seenIds || [];
    updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds, ...allPostIds])] };
    await saveLastSeen(updatedLastSeen);
    setLastSeen(updatedLastSeen);

    // Server clear-all also wipes post entries (they share the
    // deviceState.unwatched list), so update the local cache to keep
    // the UI consistent before the next /feed refresh.
    const cached = cacheRef.current[key];
    if (cached) {
      const updatedCache = { ...cacheRef.current, [key]: { ...cached } };
      let changed = false;

      // Mark all videos as watched
      if (cached.videos?.some((v) => v.unwatched)) {
        updatedCache[key] = {
          ...updatedCache[key],
          videos: cached.videos.map((v) => ({ ...v, unwatched: false })),
        };
        changed = true;
      }

      // Mark all posts as watched
      if (cached.posts?.some(isPostUnwatched)) {
        updatedCache[key] = {
          ...updatedCache[key],
          posts: cached.posts.map((p) => ({ ...p, unwatched: false })),
        };
        changed = true;
      }

      if (changed) {
        cacheRef.current = updatedCache;
        setCache(updatedCache);
        try { await saveChannelCache(updatedCache); } catch {}
      }
    }

    const deviceId = await getDeviceId();
    markSeen(deviceId, channel.channelId, [], true).catch(() => {});

    Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const handleTap = async (channel) => {
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };

    if (settings.tapAction === 'channel') {
      const allIds = getVideos(key).map(v => v.videoId);
      const allPostIds = getPosts(key).map(getPostSeenId).filter(Boolean);
      const existing = updatedLastSeen[key].seenIds || [];
      updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds, ...allPostIds])] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);

      // Server clear-all wipes both video and post entries. Mirror that locally.
      const cached = cacheRef.current[key];
      if (cached) {
        const updatedCache = { ...cacheRef.current, [key]: { ...cached } };
        let changed = false;

        if (cached.videos?.some((v) => v.unwatched)) {
          updatedCache[key] = {
            ...updatedCache[key],
            videos: cached.videos.map((v) => ({ ...v, unwatched: false })),
          };
          changed = true;
        }
        if (cached.posts?.some(isPostUnwatched)) {
          updatedCache[key] = {
            ...updatedCache[key],
            posts: cached.posts.map((p) => ({ ...p, unwatched: false })),
          };
          changed = true;
        }

        if (changed) {
          cacheRef.current = updatedCache;
          setCache(updatedCache);
          try { await saveChannelCache(updatedCache); } catch {}
        }
      }

      const deviceId = await getDeviceId();
      markSeen(deviceId, channel.channelId, [], true).catch(() => {});

      Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
    } else {
      const video = getCurrentVideo(key);
      if (video) {
        const seenIds = updatedLastSeen[key].seenIds || [];
        if (!seenIds.includes(video.videoId)) {
          updatedLastSeen[key] = { seenIds: [...seenIds, video.videoId] };
        }
        await saveLastSeen(updatedLastSeen);
        setLastSeen(updatedLastSeen);

        const deviceId = await getDeviceId();
        markSeen(deviceId, channel.channelId, [video.videoId]).catch(() => {});

        Linking.openURL(video.link);
      }
    }

    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const handleVideoTap = async (channel, video) => {
    // When tapAction is 'channel', tapping a video row does the
    // same as tapping the avatar/channel name: mark all seen +
    // open the channel page. This makes the setting consistent
    // across notifications, widget, and app feed.
    if (settings.tapAction === 'channel') {
      handleChannelOpen(channel);
      return;
    }

    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const seenIds = updatedLastSeen[key].seenIds || [];
    if (!seenIds.includes(video.videoId)) {
      updatedLastSeen[key] = { seenIds: [...seenIds, video.videoId] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);

      const deviceId = await getDeviceId();
      markSeen(deviceId, channel.channelId, [video.videoId]).catch(() => {});
    }
    Linking.openURL(video.link);
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const handlePostTap = async (channel, post) => {
    // When tapAction is 'channel', tapping a post does the same as
    // tapping a video: mark all seen + open the channel page.
    if (settings.tapAction === 'channel') {
      handleChannelOpen(channel);
      return;
    }

    // Default: mark this post as seen server-side and open it.
    const key = channel.handle;
    const postKey = getPostSeenId(post);
    if (!postKey) return;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const seenIds = updatedLastSeen[key].seenIds || [];
    if (!seenIds.includes(postKey)) {
      updatedLastSeen[key] = { seenIds: [...seenIds, postKey] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);
    }

    const cached = cacheRef.current[key];
    if (cached?.posts) {
      const updatedPosts = cached.posts.map((p) =>
        p.activityId === post.activityId ? { ...p, unwatched: false } : p
      );
      const updatedCache = { ...cacheRef.current, [key]: { ...cached, posts: updatedPosts } };
      cacheRef.current = updatedCache;
      setCache(updatedCache);
      try {
        await saveChannelCache(updatedCache);
      } catch {}
    }

    const deviceId = await getDeviceId();
    markSeen(deviceId, channel.channelId, [postKey]).catch(() => {});

    Linking.openURL(post.link);
  };

  const getUnseenPosts = (handle) => {
    const latestVideo = getVideos(handle)[0] || null;
    return getPosts(handle).filter((post) => (
      isPostUnwatched(post)
      && chooseLatestChannelContent(latestVideo, post)?.type === 'post'
    ));
  };

  const isNew = (handle) => unseenCount(handle) > 0 || getUnseenPosts(handle).length > 0;

  const timeAgo = (dateStr) => {
    if (!dateStr) return '';
    const publishedMs = new Date(dateStr).getTime();
    if (!Number.isFinite(publishedMs)) return '';
    const diff = Math.max(0, nowMs - publishedMs);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 52) return `${weeks}w`;
    return `${Math.floor(days / 365)}y`;
  };

  const formatViews = (views) => {
    const n = parseInt(views, 10);
    if (isNaN(n)) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    return `${n} views`;
  };

  // For likes/dislikes: just the compact number, no "views" suffix
  const formatCount = (n) => {
    const num = parseInt(n, 10);
    if (isNaN(num)) return '';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return `${num}`;
  };

  const renderChannel = ({ item }) => {
    const cached = cache[item.handle];
    const hasNew = isNew(item.handle);
    const displayName = cached?.name || item.name || item.handle;
    const unseenVids = getUnseenVideos(item.handle);
    const persistent = selectPersistentLatestContent(item.handle);
    const videosToShow = unseenVids.length > 0
      ? [...unseenVids].reverse()
      : (persistent?.type === 'video' ? [persistent.item] : []);
    const posts = getVisiblePosts(item.handle);

    return (
      <View style={[styles.channelSection, hasNew && styles.channelSectionNew]}>
        <View style={styles.channelHeaderRow}>
          <TouchableOpacity
            onPress={() => handleChannelOpen(item)}
            style={[styles.avatarContainer, hasNew && styles.avatarGlow]}
            activeOpacity={0.7}
          >
            {cached?.avatar ? (
              <Image source={{ uri: cached.avatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.channelNameBtn} onPress={() => handleChannelOpen(item)} activeOpacity={0.7}>
            <Text style={[styles.channelName, hasNew && styles.channelNameNew]} numberOfLines={1}>
              {displayName}
            </Text>
          </TouchableOpacity>
        </View>

        {posts.length > 0 && (
          <View style={styles.postsGroupHeader}>
            <Text style={styles.postsGroupHeaderText}>Posts</Text>
          </View>
        )}

        {posts.map((post) => {
          // Server-driven: post.unwatched reflects the device's
          // per-channel state. No local seenIds lookup.
          const isSeen = !post.unwatched;
          const likeLabel = post.likeCount != null ? formatCount(post.likeCount) : null;
          const viewLabel = post.viewCount != null ? formatViews(post.viewCount) : (post.viewText || null);
          return (
            <TouchableOpacity
              key={post.activityId}
              style={styles.postRow}
              onPress={() => handlePostTap(item, post)}
              activeOpacity={0.7}
            >
              {post.thumbnail ? (
                <Image source={{ uri: post.thumbnail }} style={styles.postThumbnail} resizeMode="contain" />
              ) : (
                <View style={styles.postPlaceholder}>
                  {cached?.avatar ? (
                    <Image source={{ uri: cached.avatar }} style={styles.postPlaceholderAvatar} />
                  ) : (
                    <View style={[styles.postPlaceholderAvatar, styles.avatarPlaceholder]}>
                      <Text style={styles.postPlaceholderLetter}>
                        {displayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  {/* Speech-bubble tail (decorative) */}
                  <View style={styles.postPlaceholderTail} />
                </View>
              )}

              <View style={styles.postInfo}>
                <Text style={styles.postHeader} numberOfLines={1}>
                  {post.kind === 'poll' ? 'Posted a poll' : post.kind === 'image' ? 'Posted an image' : 'Posted'}
                </Text>
                <Text
                  style={[styles.postBody, !isSeen && { color: COLORS.text, fontWeight: '600' }]}
                  numberOfLines={1}
                >
                  {post.text}
                </Text>
                <View style={styles.videoMeta}>
                  <View style={styles.metaLeft}>
                    <Text style={styles.timeAgo}>{post.publishedAt ? timeAgo(post.publishedAt) : (post.publishedText || '')}</Text>
                    {likeLabel && (
                      <View style={styles.metaLikeGroup}>
                        <SvgXml xml={THUMB_UP_SVG} width={12} height={12} style={styles.metaIcon} />
                        <Text style={styles.metaLikeCount}>{likeLabel}</Text>
                      </View>
                    )}
                  </View>
                  {viewLabel && (
                    <Text style={styles.timeAgo}>{viewLabel}</Text>
                  )}
                </View>
              </View>
              {!isSeen && <View style={styles.newDot} />}
            </TouchableOpacity>
          );
        })}

        {videosToShow.map((video) => {
          const isSeen = !getUnseenVideos(item.handle).find(v => v.videoId === video.videoId);
          return (
            <TouchableOpacity
              key={video.videoId}
              style={styles.videoRow}
              onPress={() => handleVideoTap(item, video)}
              activeOpacity={0.7}
            >
              {video.thumbnail ? (
                <Image source={{ uri: video.thumbnail }} style={styles.thumbnail} />
              ) : (
                <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
              )}

              <View style={styles.videoInfo}>
                <Text style={[styles.videoTitle, !isSeen && { color: COLORS.text, fontWeight: 'bold' }]} numberOfLines={2}>
                  {video.title}
                </Text>
                {(video.published || video.views || video.likes || video.dislikes) && (
                  <View style={styles.videoMeta}>
                    <View style={styles.metaLeft}>
                      {video.published ? <Text style={styles.timeAgo}>{timeAgo(video.published)}</Text> : null}
                      <View style={styles.metaLikeGroup}>
                        <SvgXml xml={THUMB_UP_SVG} width={12} height={12} style={styles.metaIcon} />
                        <Text style={styles.metaLikeCount}>{formatCount(video.likes || 0)}</Text>
                      </View>
                      {video.dislikes && video.dislikes !== '0' && (
                        <View style={styles.metaLikeGroup}>
                          <SvgXml xml={THUMB_DOWN_SVG} width={12} height={12} style={styles.metaIcon} />
                          <Text style={styles.metaLikeCount}>{formatCount(video.dislikes)}</Text>
                        </View>
                      )}
                    </View>
                    {video.views && video.views !== '0' && (
                      <Text style={styles.timeAgo}>{formatViews(video.views)}</Text>
                    )}
                  </View>
                )}
              </View>
              {!isSeen && <View style={styles.newDot} />}
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={COLORS.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.handle}
        renderItem={renderChannel}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={COLORS.accent}
            colors={[COLORS.accent]}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No channels added</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Channels')}>
              <Text style={styles.emptyLink}>Add channels</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
  },
  channelSection: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingBottom: 8,
  },
  channelSectionNew: {
    backgroundColor: 'rgba(79, 195, 247, 0.04)',
  },
  channelHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  channelNameBtn: {
    flex: 1,
  },
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  videoInfo: {
    flex: 1,
    marginLeft: 8,
  },
  avatarContainer: {
    marginRight: 12,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarGlow: {
    borderColor: COLORS.accent,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 4,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarPlaceholder: {
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: {
    color: COLORS.textDim,
    fontSize: 32,
    fontWeight: '700',
  },
  channelName: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
    lineHeight: 40,
    marginTop: 5,
  },
  channelNameNew: {
    color: '#FFFFFF',
  },
  videoMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  metaLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeAgo: {
    color: COLORS.textDim,
    fontSize: 12,
  },
  metaIcon: {
    marginRight: 0,
  },
  // Visual group around the thumb + count so we can give the count
  // breathing room from the icon without relying on the icon's
  // own right-margin (which gets eaten by the parent gap).
  metaLikeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaLikeCount: {
    color: COLORS.textDim,
    fontSize: 12,
    marginLeft: 2,
  },
  videoTitle: {
    color: COLORS.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  thumbnail: {
    width: 85,
    height: 48,
    borderRadius: 4,
  },
  thumbnailPlaceholder: {
    backgroundColor: '#1A1A1A',
  },
  newDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.newDot,
    marginLeft: 8,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    color: COLORS.textDim,
    fontSize: 16,
  },
  emptyLink: {
    color: COLORS.accent,
    fontSize: 14,
    marginTop: 8,
  },
  // Posts
  postsGroupHeader: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 2,
  },
  postsGroupHeaderText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  postRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  postThumbnail: {
    width: 85,
    height: 48,
    borderRadius: 4,
    backgroundColor: '#111',
  },
  postPlaceholder: {
    width: 85,
    height: 48,
    borderRadius: 4,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  postPlaceholderAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    opacity: 0.6,
  },
  postPlaceholderLetter: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 24,
  },
  // Small triangular "tail" in the bottom-left corner of the bubble,
  // giving it the speech-bubble silhouette. Decorative only.
  postPlaceholderTail: {
    position: 'absolute',
    bottom: -1,
    left: 6,
    width: 8,
    height: 8,
    backgroundColor: COLORS.surface,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
    transform: [{ rotate: '45deg' }],
  },
  postInfo: {
    flex: 1,
    marginLeft: 8,
  },
  postHeader: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '500',
  },
  postBody: {
    color: COLORS.textDim,
    fontSize: 13,
    marginTop: 2,
    lineHeight: 17,
  },
});
