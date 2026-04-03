import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_FETCH_TASK } from './constants';
import { getChannels, getLastSeen, saveLastSeen, saveChannelCache } from './storage';
import { checkAllChannels } from './rss';
import { sendNewVideoNotification } from './notifications';

// Define the background task
TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const channels = await getChannels();
    const lastSeen = await getLastSeen();
    const results = await checkAllChannels(channels);

    let newContentFound = false;

    // Build cache and check for new videos
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
        // Send notification
        await sendNewVideoNotification(
          result.name,
          result.latestVideo.title,
          result.latestVideo.videoId
        );
        // Update last seen with new video but mark as unseen
        updatedLastSeen[key] = {
          videoId: result.latestVideo.videoId,
          seen: false,
        };
      }
    }

    await saveChannelCache(cache);
    await saveLastSeen(updatedLastSeen);

    return newContentFound
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (err) {
    console.error('Background fetch error:', err);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundFetch(intervalMinutes = 30) {
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
}

export async function unregisterBackgroundFetch() {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
  if (isRegistered) {
    await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
  }
}
