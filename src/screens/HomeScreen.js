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
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache, getGentleNotifState, saveGentleNotifState } from '../utils/storage';
import { fetchFeed, markSeen, getDeviceId } from '../utils/api';

export default function HomeScreen({ navigation }) {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [lastSeen, setLastSeen] = useState({});
  const [settings, setSettings] = useState({ tapAction: 'video' });
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    const [ch, s, ls, ca] = await Promise.all([
      getChannels(),
      getSettings(),
      getLastSeen(),
      getChannelCache(),
    ]);
    setChannels(ch);
    setSettings(s);
    setLastSeen(ls);
    setCache(ca);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (deviceId) {
        // Fetch from server
        const result = await fetchFeed(deviceId);
        if (result.ok && result.feeds) {
          // Merge server feed data into local cache, but don't overwrite avatar with null
          const newCache = {};
          for (const [handle, feed] of Object.entries(result.feeds)) {
            const channel = (await getChannels()).find(ch => ch.handle === handle);
            const existingEntry = cache[handle] || {};
            newCache[handle] = {
              name: feed.name || existingEntry.name,
              avatar: feed.avatar || existingEntry.avatar || null,
              videos: feed.videos || [],
              latestVideo: feed.videos?.[0] || null,
              channelId: channel?.channelId || null,
              lastChecked: feed.lastChecked,
            };
          }
          await saveChannelCache(newCache);
          setCache(newCache);

          // Also update lastSeen from server if available
          if (result.lastSeen) {
            await saveLastSeen(result.lastSeen);
            setLastSeen(result.lastSeen);
          }

          // Update settings from server
          if (result.settings) {
            const { saveSettings } = require('../utils/storage');
            await saveSettings(result.settings);
            setSettings(result.settings);
          }
        }
      } else {
        // Fallback: load from local cache
        const ca = await getChannelCache();
        setCache(ca);
      }
    } catch (e) {
      console.warn('Refresh failed:', e);
      // Fallback to local cache
      const ca = await getChannelCache();
      setCache(ca);
    }
    setRefreshing(false);

    // Update widget
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}

  // Auto-fetch on first open if cache is empty
  const autoFetch = useCallback(async () => {
    const [ch, ca] = await Promise.all([getChannels(), getChannelCache()]);
    if (Object.keys(ca).length === 0 && ch.length > 0) {
      await refresh();
    }
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  useEffect(() => {
    autoFetch();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadData();
        // Refresh from server when coming back to foreground
        refresh();
        try {
          const { requestWidgetUpdate } = require('react-native-android-widget');
          requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
        } catch {}
      }
    });

    return () => sub.remove();
  }, [loadData, refresh, autoFetch]);

  // Returns videos sorted newest-first
  const getVideos = (handle) => {
    const cached = cache[handle];
    if (!cached) return [];
    const vids = cached.videos?.length ? cached.videos : (cached.latestVideo ? [cached.latestVideo] : []);
    return [...vids].sort((a, b) => new Date(b.published) - new Date(a.published));
  };

  const getUnseenVideos = (handle) => {
    const seenIds = lastSeen[handle]?.seenIds || [];
    return getVideos(handle).filter(v => !seenIds.includes(v.videoId));
  };

  const unseenCount = (handle) => getUnseenVideos(handle).length;

  const getCurrentVideo = (handle) => {
    const unseen = getUnseenVideos(handle);
    if (unseen.length > 0) return unseen[unseen.length - 1];
    const vids = getVideos(handle);
    return vids[0] || null;
  };

  const handleChannelOpen = async (channel) => {
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const allIds = getVideos(key).map(v => v.videoId);
    const existing = updatedLastSeen[key].seenIds || [];
    updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds])] };
    await saveLastSeen(updatedLastSeen);
    setLastSeen(updatedLastSeen);

    // Mark seen on server
    if (deviceId) {
      markSeen(deviceId, key, allIds).catch(() => {});
    }

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
      const existing = updatedLastSeen[key].seenIds || [];
      updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds])] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);

      if (deviceId) {
        markSeen(deviceId, key, allIds).catch(() => {});
      }

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

        if (deviceId) {
          markSeen(deviceId, key, [video.videoId]).catch(() => {});
        }

        Linking.openURL(video.link);
      }
    }

    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const handleVideoTap = async (channel, video) => {
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const seenIds = updatedLastSeen[key].seenIds || [];
    if (!seenIds.includes(video.videoId)) {
      updatedLastSeen[key] = { seenIds: [...seenIds, video.videoId] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);

      if (deviceId) {
        markSeen(deviceId, key, [video.videoId]).catch(() => {});
      }
    }
    Linking.openURL(video.link);
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const isNew = (handle) => unseenCount(handle) > 0;

  const timeAgo = (dateStr) => {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const formatViews = (views) => {
    const n = parseInt(views, 10);
    if (isNaN(n)) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
    return `${n} views`;
  };

  const renderChannel = ({ item }) => {
    const cached = cache[item.handle];
    const hasNew = isNew(item.handle);
    const displayName = cached?.name || item.name || item.handle;
    const unseenVids = getUnseenVideos(item.handle);
    const latestVideo = getVideos(item.handle)[0] || null;
    const videosToShow = unseenVids.length > 0 ? [...unseenVids].reverse() : (latestVideo ? [latestVideo] : []);

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
                {(video.published || video.views) && (
                  <View style={styles.videoMeta}>
                    <Text style={styles.timeAgo}>{video.published ? timeAgo(video.published) : ''}</Text>
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
    marginTop: 2,
  },
  timeAgo: {
    color: COLORS.textDim,
    fontSize: 12,
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
});