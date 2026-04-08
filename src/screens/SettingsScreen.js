import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Linking, Platform, Switch, TextInput, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, DEFAULT_SETTINGS } from '../utils/constants';
import { getSettings, saveSettings } from '../utils/storage';
import { registerBackgroundFetch } from '../utils/backgroundTask';

const POLL_OPTIONS = [5, 15, 30, 60, 120];

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

    if (key === 'pollIntervalMinutes') {
      await registerBackgroundFetch(value);
    }
  };

  const isGentle = settings.notificationMode === 'gentle';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Tap Action */}
      <Text style={styles.sectionTitle}>On tap, open:</Text>
      <View style={styles.optionGroup}>
        <TouchableOpacity
          style={[styles.option, settings.tapAction === 'video' && styles.optionActive]}
          onPress={() => updateSetting('tapAction', 'video')}
        >
          <Text style={[styles.optionText, settings.tapAction === 'video' && styles.optionTextActive]}>
            Video
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.option, settings.tapAction === 'channel' && styles.optionActive]}
          onPress={() => updateSetting('tapAction', 'channel')}
        >
          <Text style={[styles.optionText, settings.tapAction === 'channel' && styles.optionTextActive]}>
            Channel page
          </Text>
        </TouchableOpacity>
      </View>

      {/* Poll Interval */}
      <Text style={styles.sectionTitle}>Check for new videos every:</Text>
      <View style={styles.optionGroup}>
        {POLL_OPTIONS.map((mins) => (
          <TouchableOpacity
            key={mins}
            style={[styles.option, settings.pollIntervalMinutes === mins && styles.optionActive]}
            onPress={() => updateSetting('pollIntervalMinutes', mins)}
          >
            <Text style={[styles.optionText, settings.pollIntervalMinutes === mins && styles.optionTextActive]}>
              {mins < 60 ? `${mins}m` : `${mins / 60}h`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Notification Mode */}
      <Text style={styles.sectionTitle}>Notification mode</Text>
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleOption, !isGentle && styles.toggleOptionActive]}
          onPress={() => updateSetting('notificationMode', 'persistent')}
        >
          <Text style={[styles.toggleOptionText, !isGentle && styles.toggleOptionTextActive]}>
            Persistent
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleOption, isGentle && styles.toggleOptionActive]}
          onPress={() => updateSetting('notificationMode', 'gentle')}
        >
          <Text style={[styles.toggleOptionText, isGentle && styles.toggleOptionTextActive]}>
            Gentle
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.guidance}>
        {isGentle
          ? 'Gentle: notifies you once when a video drops, then reminds you every 4 hours until you watch it.'
          : 'Persistent: notifies you on every check cycle until you open the video.'}
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
            During DND, notifications appear silently — no sound or vibration.
          </Text>
          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>From</Text>
              <TextInput
                style={styles.timeInput}
                value={settings.dndStart || '23:00'}
                onChangeText={(v) => updateSetting('dndStart', v)}
                placeholder="23:00"
                placeholderTextColor={COLORS.textDim}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>
            <Text style={styles.timeSep}>→</Text>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>Until</Text>
              <TextInput
                style={styles.timeInput}
                value={settings.dndEnd || '08:00'}
                onChangeText={(v) => updateSetting('dndEnd', v)}
                placeholder="08:00"
                placeholderTextColor={COLORS.textDim}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>
          </View>
        </>
      )}

      {/* Battery Optimization */}
      <Text style={styles.sectionTitle}>Background polling</Text>
      <Text style={styles.guidance}>
        For reliable notifications and widget updates, disable battery optimization for TubePulse.
        Otherwise Android may pause polling when the app is in the background.
      </Text>
      {Platform.OS === 'android' && (
        <TouchableOpacity
          style={styles.batteryButton}
          onPress={() => Linking.openSettings()}
        >
          <Text style={styles.batteryButtonText}>Open App Settings</Text>
        </TouchableOpacity>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: COLORS.textDim,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 10,
  },
  optionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
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
  toggleRow: {
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
    alignSelf: 'flex-start',
  },
  toggleOption: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: COLORS.surface,
  },
  toggleOptionActive: {
    backgroundColor: COLORS.accent,
  },
  toggleOptionText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  toggleOptionTextActive: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  guidance: {
    color: COLORS.textDim,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
    marginBottom: 4,
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
    gap: 12,
    marginTop: 10,
  },
  timeField: {
    alignItems: 'center',
  },
  timeLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    marginBottom: 4,
  },
  timeInput: {
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    width: 90,
  },
  timeSep: {
    color: COLORS.textDim,
    fontSize: 18,
    marginTop: 16,
  },
  batteryButton: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  batteryButtonText: {
    color: COLORS.accent,
    fontSize: 14,
    fontWeight: '600',
  },
});
