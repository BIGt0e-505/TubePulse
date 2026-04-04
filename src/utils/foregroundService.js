import BackgroundService from 'react-native-background-actions';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from './storage';
import { checkAllChannels } from './rss';
import { sendNewVideoNotification } from './notifications';

async function pollChannels() {
  try {
    const channels = await getChannels();
    if (channels.length === 0) return;

    const lastSeen = await getLastSeen();
    const existingCache = await getChannelCache();
    const results = await checkAllChannels(channels);

    const cache = { ...existingCache };
    const updatedLastSeen = { ...lastSeen };
    let newContentFound = false;

    for (const result of results) {
      if (result.error || !result.latestVideo) continue;

      const key = result.handle;
      cache[key] = {
        name: result.name,
        avatar: result.avatar,
        videos: result.videos,
        latestVideo: result.latestVideo,
        channelId: result.channelId,
        lastChecked: new Date().toISOString(),
      };

      // Migrate old format if needed
      if (updatedLastSeen[key] && !updatedLastSeen[key].seenIds) {
        const oldId = updatedLastSeen[key].videoId;
        const wasSeen = updatedLastSeen[key].seen;
        updatedLastSeen[key] = { seenIds: wasSeen && oldId ? [oldId] : [] };
      }

      const seenIds = updatedLastSeen[key]?.seenIds || [];
      if (!seenIds.includes(result.latestVideo.videoId)) {
        newContentFound = true;
        await sendNewVideoNotification(
          result.name,
          result.latestVideo.title,
          result.latestVideo.videoId,
          result.handle,
          result.latestVideo.link
        );
        if (!updatedLastSeen[key]) {
          updatedLastSeen[key] = { seenIds: [] };
        }
      }
    }

    await saveChannelCache(cache);
    await saveLastSeen(updatedLastSeen);

    // Update widget
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  } catch (err) {
    console.warn('Foreground service poll failed:', err);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serviceTask = async () => {
  while (BackgroundService.isRunning()) {
    await pollChannels();
    // Read poll interval from settings each cycle so changes take effect
    const settings = await getSettings();
    const intervalMs = (settings.pollIntervalMinutes || 30) * 60 * 1000;
    await sleep(intervalMs);
  }
};

const serviceOptions = {
  taskName: 'TubePulse',
  taskTitle: 'TubePulse',
  taskDesc: 'Watching for new videos',
  taskIcon: {
    name: 'ic_launcher',
    type: 'mipmap',
  },
  color: '#4FC3F7',
  parameters: {},
};

export async function startForegroundService() {
  if (BackgroundService.isRunning()) return;
  try {
    await BackgroundService.start(serviceTask, serviceOptions);
  } catch (e) {
    console.warn('Failed to start foreground service:', e);
  }
}

export async function stopForegroundService() {
  try {
    await BackgroundService.stop();
  } catch (e) {
    console.warn('Failed to stop foreground service:', e);
  }
}
