import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getSettings, saveSettings } from '../utils/storage';
import { registerBackgroundFetch } from '../utils/backgroundTask';

const POLL_OPTIONS = [15, 30, 60, 120];

export default function SettingsScreen() {
  const [settings, setSettings] = useState({ tapAction: 'video', pollIntervalMinutes: 30 });

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

  return (
    <View style={styles.container}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    padding: 16,
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
});
