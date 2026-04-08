import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_FETCH_TASK } from './constants';
import {
  getChannels,
  getLastSeen,
  saveLastSeen,
  getChannelCache,
  saveChannelCache,
  getSettings,
  getGentleNotifState,
  saveGentleNotifState,
} from './storage';
import { checkAllChannels } from './rss';
import { sendNewVideoNotification } from './notifications';

const GENTLE_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Define the background task — wrapped in try/catch since this runs at import time
try {
  TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
    try {
      const [channels, lastSeen, existingCache, settings, gentleState] = await Promise.all([
        getChannels(),
        getLastSeen(),
        getChannelCache(),
        getSettings(),
        getGentleNotifState(),
      ]);

      const results = await checkAllChannels(channels);
      const notificationMode = settings.notificationMode || 'persistent';

      let newContentFound = false;
      const cache = { ...existingCache };
      const updatedLastSeen = { ...lastSeen };
      const updatedGentleState = { ...gentleState };
      const now = Date.now();

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
        const videoId = result.latestVideo.videoId;
        const isUnseen = !seenIds.includes(videoId);

        if (!isUnseen) {
          // Video already seen — clean up gentle state if present
          if (updatedGentleState[key]?.videoId === videoId) {
            delete updatedGentleState[key];
          }
          continue;
        }

        // Seed new channels
        if (!updatedLastSeen[key]) {
          updatedLastSeen[key] = { seenIds: [] };
        }

        if (notificationMode === 'relentless' || notificationMode === 'persistent') {
          // Fire every poll cycle until the user opens/marks seen
          newContentFound = true;
          await sendNewVideoNotification(
            result.name,
            result.latestVideo.title,
            videoId,
            key,
            result.latestVideo.link,
            settings
          );
        } else {
          // Gentle mode: notify once, then remind every 4h if still unseen
          const gentle = updatedGentleState[key];

          if (!gentle || gentle.videoId !== videoId) {
            // First time we've seen this video — send the initial notification
            newContentFound = true;
            await sendNewVideoNotification(
              result.name,
              result.latestVideo.title,
              videoId,
              key,
              result.latestVideo.link,
              settings
            );
            updatedGentleState[key] = {
              videoId,
              firstNotifiedAt: now,
              lastRemindedAt: now,
            };
          } else if (now - gentle.lastRemindedAt >= GENTLE_REMINDER_INTERVAL_MS) {
            // Already notified once — send a reminder after 4h
            newContentFound = true;
            await sendNewVideoNotification(
              result.name,
              result.latestVideo.title,
              videoId,
              key,
              result.latestVideo.link,
              settings
            );
            updatedGentleState[key] = { ...gentle, lastRemindedAt: now };
          }
          // Otherwise: stay quiet
        }
      }

      await saveChannelCache(cache);
      await saveLastSeen(updatedLastSeen);
      await saveGentleNotifState(updatedGentleState);

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
