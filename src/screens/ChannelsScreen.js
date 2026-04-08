import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import {
  getChannels, saveChannels,
  getChannelCache, saveChannelCache,
  getLastSeen, saveLastSeen,
} from '../utils/storage';
import { checkAllChannels } from '../utils/rss';

export default function ChannelsScreen() {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [newHandle, setNewHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');


  useFocusEffect(
    useCallback(() => {
      Promise.all([getChannels(), getChannelCache()]).then(([chs, ca]) => {
        setChannels(chs);
        setCache(ca);
      });
    }, [])
  );

  const addChannel = async () => {
    const handle = newHandle.trim().replace(/^@/, '');
    if (!handle) return;

    setAddError('');

    if (channels.some((c) => c.handle.toLowerCase() === handle.toLowerCase())) {
      setAddError(`@${handle} is already in your list.`);
      return;
    }

    setAdding(true);
    const newChannel = { handle, name: handle, channelId: null };

    try {
      const results = await checkAllChannels([newChannel]);
      const r = results[0];

      if (!r || r.error || !r.latestVideo) {
        setAddError(`Couldn't find @${handle} — check the handle and try again.`);
        setAdding(false);
        return;
      }

      // Valid channel — save it
      const updated = [...channels, { handle, name: r.name || handle, channelId: r.channelId || null }];
      await saveChannels(updated);
      setChannels(updated);
      setNewHandle('');

      // Cache data
      const existingCache = await getChannelCache();
      existingCache[r.handle] = {
        name: r.name,
        avatar: r.avatar,
        videos: r.videos,
        latestVideo: r.latestVideo,
        channelId: r.channelId,
        lastChecked: new Date().toISOString(),
      };
      await saveChannelCache(existingCache);
      setCache({ ...existingCache });

      // Seed as already seen
      const lastSeen = await getLastSeen();
      if (!lastSeen[r.handle]) {
        lastSeen[r.handle] = { seenIds: [r.latestVideo.videoId] };
        await saveLastSeen(lastSeen);
      }

      // Update widget
      try {
        const { requestWidgetUpdate } = require('react-native-android-widget');
        await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
      } catch {}

    } catch (err) {
      setAddError(`Something went wrong. Check your connection and try again.`);
    }

    setAdding(false);
  };

  const removeChannel = (handle) => {
    Alert.alert(
      'Remove channel',
      `Remove @${handle} from your list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const updated = channels.filter((c) => c.handle !== handle);
            await saveChannels(updated);
            setChannels(updated);
          },
        },
      ]
    );
  };

  const onDragEnd = async ({ data }) => {
    setChannels(data);
    await saveChannels(data);
  };

  const renderItem = ({ item, drag, isActive }) => {
    const cached = cache[item.handle];
    const displayName = cached?.name || item.name || item.handle;

    return (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={drag}
          delayLongPress={150}
          style={[styles.channelRow, isActive && styles.channelRowActive]}
          activeOpacity={1}
        >
          {/* Drag handle */}
          <Text style={styles.dragHandle}>☰</Text>

          {/* Avatar */}
          <View style={styles.avatarWrap}>
            {cached?.avatar ? (
              <Image source={{ uri: cached.avatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </View>

          {/* Name + handle */}
          <View style={styles.channelInfo}>
            <Text style={styles.channelName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.channelHandle}>@{item.handle}</Text>
          </View>

          {/* Remove */}
          <TouchableOpacity onPress={() => removeChannel(item.handle)} style={styles.removeBtn}>
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </ScaleDecorator>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Add row */}
      <View style={styles.addSection}>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            placeholder="@handle"
            placeholderTextColor={COLORS.textDim}
            value={newHandle}
            onChangeText={(t) => { setNewHandle(t); setAddError(''); }}
            onSubmitEditing={addChannel}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.addButton} onPress={addChannel} disabled={adding}>
            {adding ? (
              <ActivityIndicator color={COLORS.bg} size="small" />
            ) : (
              <Text style={styles.addButtonText}>Add</Text>
            )}
          </TouchableOpacity>
        </View>
        {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
      </View>

      {channels.length === 0 && (
        <Text style={styles.emptyText}>No channels yet. Add one above.</Text>
      )}

      <DraggableFlatList
        data={channels}
        keyExtractor={(item) => item.handle}
        renderItem={renderItem}
        onDragEnd={onDragEnd}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  addSection: {
    padding: 16,
    paddingBottom: 8,
  },
  addRow: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
    minWidth: 70,
    alignItems: 'center',
  },
  addButtonText: {
    color: COLORS.bg,
    fontWeight: '700',
    fontSize: 15,
  },
  errorText: {
    color: COLORS.danger,
    fontSize: 13,
    marginTop: 8,
  },

  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  channelRowActive: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
  },
  dragHandle: {
    color: COLORS.textDim,
    fontSize: 18,
    marginRight: 12,
    opacity: 0.5,
  },
  avatarWrap: {
    marginRight: 12,
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
    fontSize: 18,
    fontWeight: '700',
  },
  channelInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  channelName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
  },
  channelHandle: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 1,
  },
  removeBtn: {
    paddingHorizontal: 4,
  },
  removeText: {
    color: COLORS.danger,
    fontSize: 13,
  },

  emptyText: {
    color: COLORS.textDim,
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },
});
