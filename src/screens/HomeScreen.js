import React, { useState, useCallback } from 'react';
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
} from 'react-native';
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
          latestVideo: r.latestVideo,
          channelId: r.channelId,
          lastChecked: new Date().toISOString(),
        };
        if (!updatedLastSeen[r.handle]) {
          updatedLastSeen[r.handle] = { videoId: r.latestVideo.videoId, seen: false };
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

  const refresh = async () => {
    setRefreshing(true);
    const ch = await getChannels();
    const results = await checkAllChannels(ch);
    const ls = await getLastSeen();

    const newCache = {};
    const updatedLastSeen = { ...ls };

    for (const r of results) {
      if (r.error || !r.latestVideo) continue;
      newCache[r.handle] = {
        name: r.name,
        avatar: r.avatar,
        latestVideo: r.latestVideo,
        channelId: r.channelId,
        lastChecked: new Date().toISOString(),
      };
      // If we haven't seen this channel before, mark as unseen
      if (!updatedLastSeen[r.handle]) {
        updatedLastSeen[r.handle] = { videoId: r.latestVideo.videoId, seen: false };
      } else if (updatedLastSeen[r.handle].videoId !== r.latestVideo.videoId) {
        updatedLastSeen[r.handle] = { videoId: r.latestVideo.videoId, seen: false };
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

  const handleTap = async (channel) => {
    const key = channel.handle;
    const cached = cache[key];

    // Mark as seen
    const updatedLastSeen = { ...lastSeen };
    if (updatedLastSeen[key]) {
      updatedLastSeen[key].seen = true;
    }
    await saveLastSeen(updatedLastSeen);
    setLastSeen(updatedLastSeen);

    // Open URL
    if (settings.tapAction === 'video' && cached?.latestVideo) {
      Linking.openURL(cached.latestVideo.link);
    } else {
      Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
    }
  };

  const isNew = (handle) => {
    const ls = lastSeen[handle];
    return ls && !ls.seen;
  };

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

  const renderChannel = ({ item }) => {
    const cached = cache[item.handle];
    const hasNew = isNew(item.handle);

    return (
      <TouchableOpacity
        style={[styles.channelRow, hasNew && styles.channelRowNew]}
        onPress={() => handleTap(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatarContainer, hasNew && styles.avatarGlow]}>
          {cached?.avatar ? (
            <Image source={{ uri: cached.avatar }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarLetter}>
                {(item.name || item.handle).charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.channelInfo}>
          <View style={styles.channelHeader}>
            <Text style={[styles.channelName, hasNew && styles.channelNameNew]} numberOfLines={1}>
              {cached?.name || item.name || item.handle}
            </Text>
            {cached?.latestVideo && (
              <Text style={styles.timeAgo}>{timeAgo(cached.latestVideo.published)}</Text>
            )}
          </View>
          <Text style={[styles.videoTitle, hasNew && styles.videoTitleNew]} numberOfLines={1}>
            {cached?.latestVideo?.title || 'No videos yet'}
          </Text>
        </View>
        {hasNew && <View style={styles.newDot} />}
      </TouchableOpacity>
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
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  channelRowNew: {
    backgroundColor: 'rgba(79, 195, 247, 0.05)',
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
    fontSize: 16,
    fontWeight: '600',
  },
  channelInfo: {
    flex: 1,
  },
  channelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  channelName: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  channelNameNew: {
    color: COLORS.text,
  },
  timeAgo: {
    color: COLORS.textDim,
    fontSize: 12,
    marginLeft: 8,
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
