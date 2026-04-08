import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Linking, Platform, Switch, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, DEFAULT_SETTINGS } from '../utils/constants';
import { getSettings, saveSettings } from '../utils/storage';
import { registerBackgroundFetch } from '../utils/backgroundTask';

const POLL_OPTIONS = [5, 15, 30, 60, 120];

// ── Time Spinner ─────────────────────────────────────────────────────────────
function TimeSpinner({ value, onChange }) {
  const [h, m] = value.split(':').map(Number);

  const pad = (n) => String(n).padStart(2, '0');

  const adjustHour = (delta) => {
    const newH = (h + delta + 24) % 24;
    onChange(`${pad(newH)}:${pad(m)}`);
  };

  const adjustMinute = (delta) => {
    const total = h * 60 + m + delta;
    const newH = ((Math.floor(total / 60)) % 24 + 24) % 24;
    const newM = ((total % 60) + 60) % 60;
    onChange(`${pad(newH)}:${pad(newM)}`);
  };

  return (
    <View style={spinner.container}>
      {/* Hour column */}
      <View style={spinner.col}>
        <TouchableOpacity style={spinner.arrow} onPress={() => adjustHour(1)}>
          <Text style={spinner.arrowText}>▲</Text>
        </TouchableOpacity>
        <Text style={spinner.digit}>{pad(h)}</Text>
        <TouchableOpacity style={spinner.arrow} onPress={() => adjustHour(-1)}>
          <Text style={spinner.arrowText}>▼</Text>
        </TouchableOpacity>
      </View>

      <Text style={spinner.colon}>:</Text>

      {/* Minute column */}
      <View style={spinner.col}>
        <TouchableOpacity style={spinner.arrow} onPress={() => adjustMinute(15)}>
          <Text style={spinner.arrowText}>▲</Text>
        </TouchableOpacity>
        <Text style={spinner.digit}>{pad(m)}</Text>
        <TouchableOpacity style={spinner.arrow} onPress={() => adjustMinute(-15)}>
          <Text style={spinner.arrowText}>▼</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const spinner = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  col: {
    alignItems: 'center',
    width: 48,
  },
  arrow: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  arrowText: {
    color: COLORS.accent,
    fontSize: 18,
  },
  digit: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  colon: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
    marginHorizontal: 4,
    marginBottom: 4,
  },
});

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
    if (key === 'pollIntervalMinutes') {
      await registerBackgroundFetch(value);
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
          ? 'Chill: one notification when a video drops, then a nudge every 4 hours until you watch it.'
          : "Relentless: hammers you every check cycle until you've watched it. You asked for this."}
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
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: COLORS.textDim,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },
  sectionTitleFirst: {
    marginTop: 8,
  },
  optionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    flex: 1,
    minWidth: 60,
    paddingVertical: 12,
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
