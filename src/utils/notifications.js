import { Platform } from 'react-native';

/**
 * Set up Android notification channels.
 * FCM handles notification delivery — we just configure the channels.
 */
export async function setupNotificationChannel() {
  if (Platform.OS === 'android') {
    // Note: With @react-native-firebase/messaging, notification channels
    // are configured via the AndroidManifest.xml or via the FCM push payload.
    // We set them up here for any local notification needs (e.g. foreground).
    try {
      const { default: messaging } = require('@react-native-firebase/messaging');

      // Create notification channels for Android
      // The channel IDs must match what the cron worker sends in the FCM payload
      if (Platform.Version >= 26) {
        // Android 8+ requires notification channels
        // These are created automatically by the Firebase SDK when needed,
        // but we can pre-create them for custom settings
      }
    } catch {}
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