import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform, Switch, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, DEFAULT_SETTINGS, NAG_INTERVALS } from '../utils/constants';
import TimeSpinner from '../components/TimeSpinner';
import { getSettings, saveSettings } from '../utils/storage';
import { updateSettings } from '../utils/api';

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function SettingsScreen() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useFocusEffect(
    useCallback(() => {
      getSettings().then(setSettings);
    }, [])
  );

  const updateSetting = async (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    await saveSettings(updated);

    // Sync settings with API Worker
    try {
      const messaging = require('@react-native-firebase/messaging').default;
      const fcmToken = await messaging().getToken();
      if (fcmToken) {
        await updateSettings(fcmToken, updated);
      }
    } catch (e) {
      console.warn('Failed to sync settings with server:', e);
    }
  };

  const mode = settings.notificationMode || 'relentless';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Tap Action */}
      <Text style={[styles.sectionTitle, styles.sectionTitleFirst]}>On tap, open:</Text>
      <View style={styles.optionGroup}>
        {['video', 'channel'].map((val) => (
          <TouchableOpacity
            key={val}
            style={[styles.option, settings.tapAction === val && styles.optionActive]}
            onPress={() => updateSetting('tapAction', val)}
          >
            <Text style={[styles.optionText, settings.tapAction === val && styles.optionTextActive]}>
              {val === 'video' ? 'Video' : 'Channel page'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        {settings.tapAction === 'video'
          ? 'Opens the specific video in YouTube and marks it as watched.'
          : 'Opens the channel page in YouTube and marks all their videos as watched.'}
      </Text>

      {/* Notification Mode */}
      <Text style={styles.sectionTitle}>Notification mode</Text>
      <View style={styles.optionGroup}>
        {['chill', 'relentless'].map((val) => (
          <TouchableOpacity
            key={val}
            style={[styles.option, mode === val && styles.optionActive]}
            onPress={() => updateSetting('notificationMode', val)}
          >
            <Text style={[styles.optionText, mode === val && styles.optionTextActive]}>
              {val.charAt(0).toUpperCase() + val.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        {mode === 'chill'
          ? 'Chill: notify once, then nudge every 4 hours until you watch it.'
          : "Relentless: remind you every nag interval until you've watched it."}
      </Text>

      {/* Nag Interval */}
      <Text style={styles.sectionTitle}>Nag interval</Text>
      <View style={styles.optionGroup}>
        {NAG_INTERVALS.map(({ label, value }) => (
          <TouchableOpacity
            key={value}
            style={[styles.option, settings.nagInterval === value && styles.optionActive]}
            onPress={() => updateSetting('nagInterval', value)}
          >
            <Text style={[styles.optionText, settings.nagInterval === value && styles.optionTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        Minimum time between notifications for the same unwatched video.
      </Text>

      {/* Do Not Disturb */}
      <Text style={styles.sectionTitle}>Do not disturb</Text>
      <View style={styles.dndRow}>
        <Text style={styles.dndLabel}>Enable DND</Text>
        <Switch
          value={settings.dndEnabled || false}
          onValueChange={(v) => updateSetting('dndEnabled', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.dndEnabled ? COLORS.bg : COLORS.textDim}
        />
      </View>

      {settings.dndEnabled && (
        <>
          <Text style={styles.guidance}>
            During DND, all notifications are held. They'll come through when DND ends.
          </Text>
          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>From</Text>
              <TimeSpinner
                value={settings.dndStart || '22:00'}
                onChange={(v) => updateSetting('dndStart', v)}
              />
            </View>
            <Text style={styles.timeSep}>→</Text>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>Until</Text>
              <TimeSpinner
                value={settings.dndEnd || '07:00'}
                onChange={(v) => updateSetting('dndEnd', v)}
              />
            </View>
          </View>
        </>
      )}

      {/* Community Posts placeholder */}
      <Text style={styles.sectionTitle}>Content types</Text>
      <View style={styles.dndRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.dndLabel}>Include community posts</Text>
          <Text style={styles.switchSubtitle}>Coming soon — not yet detectable via RSS</Text>
        </View>
        <Switch
          value={settings.includeCommunityPosts || false}
          onValueChange={(v) => updateSetting('includeCommunityPosts', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.includeCommunityPosts ? COLORS.bg : COLORS.textDim}
          disabled
        />
      </View>

      {/* Per-channel notification settings */}
      <Text style={styles.sectionTitle}>Per-channel notifications</Text>
      <View style={styles.dndRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.dndLabel}>Per-channel settings</Text>
          <Text style={styles.switchSubtitle}>Override notification mode and DND per channel</Text>
        </View>
        <Switch
          value={settings.perChannelNotifications || false}
          onValueChange={(v) => updateSetting('perChannelNotifications', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.perChannelNotifications ? COLORS.bg : COLORS.textDim}
        />
      </View>
      {settings.perChannelNotifications && (
        <Text style={styles.guidance}>
          Long-press a channel to configure its own notification settings.
        </Text>
      )}

      {/* Push Architecture Note */}
      <Text style={styles.sectionTitle}>Push notifications</Text>
      <Text style={styles.guidance}>
        TubePulse uses WebSub — YouTube pushes to us the instant a video drops, then we push to you. Your phone never polls. No battery drain.
      </Text>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  sectionTitleFirst: {
    marginTop: 4,
  },
  optionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  option: {
    flex: 1,
    minWidth: 60,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  optionText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
  optionTextActive: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  guidance: {
    color: COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 2,
  },
  dndRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  dndLabel: {
    color: COLORS.text,
    fontSize: 15,
  },
  switchLabelWrap: {
    flex: 1,
    paddingRight: 12,
  },
  switchSubtitle: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 6,
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
});