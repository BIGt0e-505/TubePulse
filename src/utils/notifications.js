import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestPermissions() {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Returns true if the current time falls within DND hours.
 * Handles overnight ranges (e.g. 23:00–08:00).
 */
export function isDndActive(dndStart, dndEnd) {
  const now = new Date();
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins <= endMins) {
    // Same-day range (e.g. 09:00–17:00)
    return nowMins >= startMins && nowMins < endMins;
  } else {
    // Overnight range (e.g. 23:00–08:00)
    return nowMins >= startMins || nowMins < endMins;
  }
}

export async function sendNewVideoNotification(channelName, videoTitle, videoId, handle, videoLink, settings = {}) {
  const { dndEnabled = false, dndStart = '23:00', dndEnd = '08:00' } = settings;

  const silent = dndEnabled && isDndActive(dndStart, dndEnd);

  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${channelName} uploaded`,
      body: videoTitle,
      data: { videoId, channelName, handle, videoLink },
      sound: silent ? null : undefined, // null = no sound, undefined = default
      ...(Platform.OS === 'android' && {
        channelId: silent ? 'new-videos-silent' : 'new-videos',
      }),
    },
    trigger: null, // immediate
  });
}

export async function setupNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('new-videos', {
      name: 'New Videos',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      // No custom lightColor — use system default so badge appears white/alpha
      // like all other apps. Custom colour was making badge stand out.
    });

    // Silent channel for DND — shows notification, no sound or vibration
    await Notifications.setNotificationChannelAsync('new-videos-silent', {
      name: 'New Videos (Silent)',
      importance: Notifications.AndroidImportance.LOW,
      vibrationPattern: null,
      enableVibrate: false,
      sound: null,
    });
  }
}
