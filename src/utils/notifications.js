import { Platform } from 'react-native';

/**
 * Set up Android notification channels.
 * FCM handles notification delivery — we configure the channels here
 * so Android shows proper notification categories (instead of
 * "Miscellaneous") and sound/vibration works reliably when the
 * screen is off.
 *
 * Channel IDs must match what the workers send in the FCM payload's
 * android.notification.channel_id field.
 *
 * Current channels:
 * - "new-videos"      — standard notifications with sound (new uploads, nags, community posts)
 * - "new-videos-silent" — silent notifications (used for background cache refresh)
 */
export async function setupNotificationChannel() {
  if (Platform.OS !== 'android') return;

  try {
    // React Native Firebase messaging doesn't expose NotificationChannel
    // creation directly in JS. On Android 8+, channels are created
    // automatically by the system when a notification is delivered to a
    // channel_id that doesn't exist yet — but with default ("low")
    // importance and no sound.
    //
    // To get proper sound and a user-visible channel name, we need to
    // create the channel via the Android NotifChannel API. We use
    // expo-notifications or a direct native call if available.
    //
    // However, @react-native-firebase/messaging v24+ does NOT create
    // channels automatically. The FCM payload's android.notification.channel_id
    // tells FCM which channel to use, but the channel must exist on
    // the device first.
    //
    // Workaround: we create channels via a headless Android approach.
    // Since we can't easily call Android APIs from JS without a native
    // module, we rely on the FCM payload's channel_id and create the
    // channels via an Android XML config or a one-time native call.
    //
    // The simplest reliable approach for Expo-managed apps is to
    // NOT use @react-native-firebase/messaging's channel creation,
    // but instead ensure the channel exists by sending a first
    // notification to it (Android auto-creates with default settings).
    //
    // For proper sound and importance, the channel should be created
    // with IMPORTANCE_HIGH. We attempt this via any available API.

    // Try expo-notifications if available (it has channel creation)
    try {
      const expoNotifications = require('expo-notifications');
      if (expoNotifications?.setNotificationChannelAsync) {
        await expoNotifications.setNotificationChannelAsync('new-videos', {
          name: 'New videos & reminders',
          importance: expoNotifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF231F7C',
          sound: 'default',
        });
        await expoNotifications.setNotificationChannelAsync('new-videos-silent', {
          name: 'Background updates',
          importance: expoNotifications.AndroidImportance.LOW,
          sound: null,
        });
        console.log('[Notifications] Created Android notification channels via expo-notifications');
        return;
      }
    } catch (e) {
      console.log('[Notifications] expo-notifications not available, channels will use FCM defaults');
    }

    // Fallback: @react-native-firebase/messaging doesn't expose channel
    // creation in JS. Channels will be auto-created by Android with
    // default settings when the first FCM push arrives. The user will
    // see "Miscellaneous" until then. To fix this properly, a native
    // module or expo-notifications is needed.
    console.log('[Notifications] No channel creation API available — using FCM auto-create defaults');
  } catch (e) {
    console.warn('[Notifications] Channel setup failed:', e);
  }
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
    return nowMins >= startMins && nowMins < endMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}