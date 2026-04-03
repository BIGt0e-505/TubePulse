import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS, DEFAULT_CHANNELS, DEFAULT_SETTINGS } from './constants';

export async function getChannels() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNELS);
  if (data) {
    // Backfill channelIds from defaults for any channels that are missing them
    const channels = JSON.parse(data);
    const defaultMap = {};
    for (const d of DEFAULT_CHANNELS) {
      defaultMap[d.handle] = d.channelId;
    }
    let updated = false;
    for (const ch of channels) {
      if (!ch.channelId && defaultMap[ch.handle]) {
        ch.channelId = defaultMap[ch.handle];
        updated = true;
      }
    }
    if (updated) await saveChannels(channels);
    return channels;
  }
  // First run — seed defaults
  await saveChannels(DEFAULT_CHANNELS);
  return DEFAULT_CHANNELS;
}

export async function saveChannels(channels) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNELS, JSON.stringify(channels));
}

export async function getSettings() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
  if (data) return JSON.parse(data);
  await saveSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings) {
  await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
}

export async function getLastSeen() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.LAST_SEEN);
  return data ? JSON.parse(data) : {};
}

export async function saveLastSeen(lastSeen) {
  await AsyncStorage.setItem(STORAGE_KEYS.LAST_SEEN, JSON.stringify(lastSeen));
}

export async function getChannelCache() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNEL_CACHE);
  return data ? JSON.parse(data) : {};
}

export async function saveChannelCache(cache) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNEL_CACHE, JSON.stringify(cache));
}
