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
  Modal,
  ScrollView,
  Switch,
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import {
  getChannels, saveChannels,
  getChannelCache, saveChannelCache,
  getLastSeen, saveLastSeen,
  getSettings,
  getChannelNotifSettings, saveChannelNotifSettings,
} from '../utils/storage';
import { checkAllChannels } from '../utils/rss';
import TimeSpinner from '../components/TimeSpinner';

// Default per-channel settings (mirrors global defaults)
const DEFAULT_CHANNEL_NOTIF = {
  notificationMode: 'relentless',
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '07:00',
};

export default function ChannelsScreen() {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [newHandle, setNewHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [perChannelEnabled, setPerChannelEnabled] = useState(false);
  const [channelNotifSettings, setChannelNotifSettings] = useState({});
  const [editingChannel, setEditingChannel] = useState(null); // handle of channel being edited
  const [editingNotif, setEditingNotif] = useState(DEFAULT_CHANNEL_NOTIF);

  useFocusEffect(
    useCallback(() => {
      Promise.all([getChannels(), getChannelCache(), getSettings(), getChannelNotifSettings()]).then(
        ([chs, ca, settings, notifSettings]) => {
          setChannels(chs);
          setCache(ca);
          setPerChannelEnabled(settings.perChannelNotifications || false);
          setChannelNotifSettings(notifSettings);
        }
      );
    }, [])
  );

  const openChannelNotifSettings = (handle) => {
    const existing = channelNotifSettings[handle] || DEFAULT_CHANNEL_NOTIF;
    setEditingNotif({ ...DEFAULT_CHANNEL_NOTIF, ...existing });
    setEditingChannel(handle);
  };

  const saveChannelNotif = async () => {
    const updated = { ...channelNotifSettings, [editingChannel]: editingNotif };
    setChannelNotifSettings(updated);
    await saveChannelNotifSettings(updated);
    setEditingChannel(null);
  };

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
    const hasOverride = perChannelEnabled && !!channelNotifSettings[item.handle];

    return (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={() => {
            if (perChannelEnabled) {
              openChannelNotifSettings(item.handle);
            } else {
              drag();
            }
          }}
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
            <View style={styles.channelNameRow}>
              <Text style={styles.channelName} numberOfLines={1}>{displayName}</Text>
              {hasOverride && <View style={styles.overrideDot} />}
            </View>
            <Text style={styles.channelHandle}>
              @{item.handle}{perChannelEnabled ? '  · long-press to configure' : ''}
            </Text>
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
      {/* Per-channel notification settings modal */}
      <Modal
        visible={!!editingChannel}
        animationType="slide"
        transparent
        onRequestClose={() => setEditingChannel(null)}
      >
        <View style={styles.modalOverlay}>
          <ScrollView
            style={styles.modalSheet}
            contentContainerStyle={styles.modalSheetContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.modalTitle}>
              Notifications — @{editingChannel}
            </Text>

            <Text style={styles.modalLabel}>Notification mode</Text>
            <View style={styles.optionGroup}>
              {['chill', 'relentless'].map((val) => (
                <TouchableOpacity
                  key={val}
                  style={[styles.option, editingNotif.notificationMode === val && styles.optionActive]}
                  onPress={() => setEditingNotif(n => ({ ...n, notificationMode: val }))}
                >
                  <Text style={[styles.optionText, editingNotif.notificationMode === val && styles.optionTextActive]}>
                    {val.charAt(0).toUpperCase() + val.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Do not disturb</Text>
            <View style={styles.dndRow}>
              <Text style={styles.dndLabel}>Enable DND</Text>
              <Switch
                value={editingNotif.dndEnabled}
                onValueChange={(v) => setEditingNotif(n => ({ ...n, dndEnabled: v }))}
                trackColor={{ false: COLORS.border, true: COLORS.accent }}
                thumbColor={editingNotif.dndEnabled ? COLORS.bg : COLORS.textDim}
              />
            </View>

            {editingNotif.dndEnabled && (
              <View style={styles.timeRow}>
                <View style={styles.timeField}>
                  <Text style={styles.timeLabel}>From</Text>
                  <TimeSpinner
                    value={editingNotif.dndStart}
                    onChange={(v) => setEditingNotif(n => ({ ...n, dndStart: v }))}
                  />
                </View>
                <Text style={styles.timeSep}>→</Text>
                <View style={styles.timeField}>
                  <Text style={styles.timeLabel}>Until</Text>
                  <TimeSpinner
                    value={editingNotif.dndEnd}
                    onChange={(v) => setEditingNotif(n => ({ ...n, dndEnd: v }))}
                  />
                </View>
              </View>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setEditingChannel(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSave} onPress={saveChannelNotif}>
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
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

  channelNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  overrideDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '85%',
  },
  modalSheetContent: {
    padding: 24,
    paddingBottom: 56, // clear Android nav tray
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 20,
  },
  modalLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 16,
  },
  optionGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  option: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  optionActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  optionText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  optionTextActive: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  dndRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  dndLabel: {
    color: COLORS.text,
    fontSize: 15,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 10,
  },
  timeField: {
    alignItems: 'center',
  },
  timeLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    marginBottom: 6,
  },
  timeSep: {
    color: COLORS.textDim,
    fontSize: 20,
    marginTop: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  modalCancelText: {
    color: COLORS.textDim,
    fontSize: 15,
    fontWeight: '600',
  },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
  },
  modalSaveText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '700',
  },
});
