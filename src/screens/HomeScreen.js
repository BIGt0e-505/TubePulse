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
import * as Notifications from 'expo-notifications';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from '../utils/storage';
import { checkAllChannels } from '../utils/rss';

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

    // Auto-fetch on first open if cache is empty
    if (Object.keys(ca).length === 0 && ch.length > 0) {
      autoFetch(ch, ls);
    }
  }, []);

  const autoFetch = async (ch, ls) => {
    setRefreshing(true);
    try {
      const results = await checkAllChannels(ch);
      const newCache = {};
      const updatedLastSeen = { ...ls };

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
        // First open — mark ALL cached videos seen so user starts with a clean slate
        if (!updatedLastSeen[r.handle]) {
          const allIds = (r.videos?.length ? r.videos : [r.latestVideo]).map(v => v.videoId);
          updatedLastSeen[r.handle] = { seenIds: allIds };
        }
      }

      await saveChannelCache(newCache);
      await saveLastSeen(updatedLastSeen);
      setCache(newCache);
      setLastSeen(updatedLastSeen);

      // Request widget update
      try {
        const { requestWidgetUpdate } = require('react-native-android-widget');
        await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
      } catch {}
    } catch (e) {
      console.warn('Auto-fetch failed:', e);
    }
    setRefreshing(false);
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  // Auto-refresh at the user's configured poll interval while in foreground
  const refreshRef = useRef(null);
  useEffect(() => {
    const startInterval = async () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
      const s = await getSettings();
      const intervalMs = (s.pollIntervalMinutes || 30) * 60 * 1000;
      refreshRef.current = setInterval(() => {
        refresh();
      }, intervalMs);
    };

    startInterval();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadData();
        startInterval();
        // Sync widget whenever app comes back to foreground
        try {
          const { requestWidgetUpdate } = require('react-native-android-widget');
          requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
        } catch {}
      } else {
        if (refreshRef.current) clearInterval(refreshRef.current);
      }
    });

    // Reload data when a notification is tapped (App.js handler updates storage first,
    // then this fires to refresh the UI so tapped channels go from highlight to lowlight)
    const notifSub = Notifications.addNotificationResponseReceivedListener(() => {
      // Small delay to ensure App.js handler finishes writing to storage first
      setTimeout(() => loadData(), 300);
    });

    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
      sub.remove();
      notifSub.remove();
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    const ch = await getChannels();
    const results = await checkAllChannels(ch);
    const ls = await getLastSeen();
    const existingCache = await getChannelCache();

    const newCache = { ...existingCache };
    const updatedLastSeen = { ...ls };

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
      // Migrate old format or seed new channels (first refresh — mark all seen)
      if (!updatedLastSeen[r.handle]) {
        const allIds = (r.videos?.length ? r.videos : [r.latestVideo]).map(v => v.videoId);
        updatedLastSeen[r.handle] = { seenIds: allIds };
      } else if (!updatedLastSeen[r.handle].seenIds) {
        // Migrate from old { videoId, seen } format
        const oldId = updatedLastSeen[r.handle].videoId;
        const wasSeen = updatedLastSeen[r.handle].seen;
        updatedLastSeen[r.handle] = { seenIds: wasSeen && oldId ? [oldId] : [] };
      }
    }

    await saveChannelCache(newCache);
    await saveLastSeen(updatedLastSeen);
    setCache(newCache);
    setLastSeen(updatedLastSeen);
    setChannels(ch);
    setRefreshing(false);

    // Update widget
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  // Returns videos sorted newest-first
  const getVideos = (handle) => {
    const cached = cache[handle];
    if (!cached) return [];
    const vids = cached.videos?.length ? cached.videos : (cached.latestVideo ? [cached.latestVideo] : []);
    return [...vids].sort((a, b) => new Date(b.published) - new Date(a.published));
  };

  // Unseen videos = in the list but not in seenIds
  const getUnseenVideos = (handle) => {
    const seenIds = lastSeen[handle]?.seenIds || [];
    return getVideos(handle).filter(v => !seenIds.includes(v.videoId));
  };

  const unseenCount = (handle) => getUnseenVideos(handle).length;

  // The "current" video to show = oldest unseen, or latest if all seen
  const getCurrentVideo = (handle) => {
    const unseen = getUnseenVideos(handle);
    if (unseen.length > 0) return unseen[unseen.length - 1]; // oldest unseen
    const vids = getVideos(handle);
    return vids[0] || null;
  };

  const handleChannelOpen = async (channel) => {
    // Always marks ALL seen and opens channel page — used by pfp tap
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const allIds = getVideos(key).map(v => v.videoId);
    const existing = updatedLastSeen[key].seenIds || [];
    updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds])] };
    await saveLastSeen(updatedLastSeen);
    setLastSeen(updatedLastSeen);
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
      // Channel tap — mark ALL seen, reset count
      const allIds = getVideos(key).map(v => v.videoId);
      const existing = updatedLastSeen[key].seenIds || [];
      updatedLastSeen[key] = { seenIds: [...new Set([...existing, ...allIds])] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);
      Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
    } else {
      // Video tap — open oldest unseen, mark it seen, decrement
      const video = getCurrentVideo(key);
      if (video) {
        const seenIds = updatedLastSeen[key].seenIds || [];
        if (!seenIds.includes(video.videoId)) {
          updatedLastSeen[key] = { seenIds: [...seenIds, video.videoId] };
        }
        await saveLastSeen(updatedLastSeen);
        setLastSeen(updatedLastSeen);
        Linking.openURL(video.link);
      }
    }

    // Update widget
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

  const handleVideoTap = async (channel, video) => {
    const key = channel.handle;
    const updatedLastSeen = { ...lastSeen };
    if (!updatedLastSeen[key]) updatedLastSeen[key] = { seenIds: [] };
    const seenIds = updatedLastSeen[key].seenIds || [];
    if (!seenIds.includes(video.videoId)) {
      updatedLastSeen[key] = { seenIds: [...seenIds, video.videoId] };
      await saveLastSeen(updatedLastSeen);
      setLastSeen(updatedLastSeen);
    }
    Linking.openURL(video.link);
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  };

  const renderChannel = ({ item }) => {
    const cached = cache[item.handle];
    const hasNew = isNew(item.handle);
    const displayName = cached?.name || item.name || item.handle;
    // All unseen videos for this channel (oldest first so tapping goes chronologically)
    const unseenVids = getUnseenVideos(item.handle);
    // If nothing unseen, show the latest video as a greyed fallback
    const latestVideo = getVideos(item.handle)[0] || null;
    const videosToShow = unseenVids.length > 0 ? [...unseenVids].reverse() : (latestVideo ? [latestVideo] : []);

    return (
      <View style={[styles.channelSection, hasNew && styles.channelSectionNew]}>
        {/* Channel header row — tap pfp to open channel */}
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

        {/* Video rows — each tappable individually */}
        {videosToShow.map((video) => {
          const isSeen = !getUnseenVideos(item.handle).find(v => v.videoId === video.videoId);
          return (
            <TouchableOpacity
              key={video.videoId}
              style={styles.videoRow}
              onPress={() => handleVideoTap(item, video)}
              activeOpacity={0.7}
            >
              <View style={styles.videoInfo}>
                <Text style={[styles.videoTitle, !isSeen && styles.videoTitleNew]} numberOfLines={2}>
                  {video.title}
                </Text>
                {video.published && (
                  <Text style={styles.timeAgo}>{timeAgo(video.published)}</Text>
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
    paddingLeft: 68, // indent under avatar
  },
  videoInfo: {
    flex: 1,
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
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  channelNameNew: {
    color: '#FFFFFF',
  },
  timeAgo: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  videoTitle: {
    color: COLORS.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  videoTitleNew: {
    color: COLORS.text,
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
