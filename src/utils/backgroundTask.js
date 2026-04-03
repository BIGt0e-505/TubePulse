import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_FETCH_TASK } from './constants';
import { getChannels, getLastSeen, saveLastSeen, saveChannelCache } from './storage';
import { checkAllChannels } from './rss';
import { sendNewVideoNotification } from './notifications';

// Define the background task — wrapped in try/catch since this runs at import time
try {
  TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
    try {
      const channels = await getChannels();
      const lastSeen = await getLastSeen();
      const results = await checkAllChannels(channels);

      let newContentFound = false;
      const cache = {};
      const updatedLastSeen = { ...lastSeen };

      for (const result of results) {
        if (result.error || !result.latestVideo) continue;

        const key = result.handle;
        cache[key] = {
          name: result.name,
          avatar: result.avatar,
          latestVideo: result.latestVideo,
          channelId: result.channelId,
          lastChecked: new Date().toISOString(),
        };

        const lastSeenId = lastSeen[key]?.videoId;
        if (lastSeenId !== result.latestVideo.videoId) {
          newContentFound = true;
          await sendNewVideoNotification(
            result.name,
            result.latestVideo.title,
            result.latestVideo.videoId
          );
          updatedLastSeen[key] = {
            videoId: result.latestVideo.videoId,
            seen: false,
          };
        }
      }

      await saveChannelCache(cache);
      await saveLastSeen(updatedLastSeen);

      // Update widget with new data
      try {
        const { requestWidgetUpdate } = require('react-native-android-widget');
        await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
      } catch {}

      return newContentFound
        ? BackgroundFetch.BackgroundFetchResult.NewData
        : BackgroundFetch.BackgroundFetchResult.NoData;
    } catch (err) {
      console.error('Background fetch error:', err);
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch (e) {
  console.warn('Failed to define background task:', e);
}

export async function registerBackgroundFetch(intervalMinutes = 30) {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Denied) {
      console.warn('Background fetch is denied');
      return false;
    }

    await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
      minimumInterval: intervalMinutes * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });

    return true;
  } catch (e) {
    console.warn('Failed to register background fetch:', e);
    return false;
  }
}

export async function unregisterBackgroundFetch() {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
    }
  } catch (e) {
    console.warn('Failed to unregister background fetch:', e);
  }
}
