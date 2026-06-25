/**
 * FCM Token + Push Message Handling
 *
 * - Acquires FCM registration token
 * - Handles foreground and background messages
 * - Manages token rotation
 */

import messaging from '@react-native-firebase/messaging';

/**
 * Get the current FCM token without requesting permissions.
 * Returns null if not available.
 */
export async function getFCMToken() {
  try {
    return await messaging().getToken();
  } catch {
    return null;
  }
}

/**
 * Request notification permissions and get FCM token.
 * Returns the token string, or null if permission denied.
 */
export async function requestPermissionAndGetToken() {
  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('FCM: Notification permission denied');
      return null;
    }

    const token = await messaging().getToken();
    console.log('FCM: Got token:', token.slice(0, 20) + '...');
    return token;
  } catch (err) {
    console.error('FCM: Failed to get token:', err);
    return null;
  }
}

/**
 * Register a token rotation listener.
 * When FCM rotates the token, re-register with the API Worker.
 */
export function onTokenRefresh(callback) {
  return messaging().onTokenRefresh(async (newToken) => {
    console.log('FCM: Token refreshed:', newToken.slice(0, 20) + '...');
    if (callback) {
      await callback(newToken);
    }
  });
}

/**
 * Set up foreground message handler.
 * Called when app is in foreground and a push arrives.
 */
export function onForegroundMessage(callback) {
  return messaging().onMessage(async (remoteMessage) => {
    console.log('FCM: Foreground message:', remoteMessage.messageId);
    if (callback) {
      await callback(remoteMessage);
    }
  });
}

/**
 * Set up background/quit message handler.
 * This must be registered at the top level (outside any component).
 */
export function setBackgroundMessageHandler(handler) {
  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    console.log('FCM: Background message:', remoteMessage.messageId);
    await handler(remoteMessage);
  });
}

/**
 * Check if the app was opened from a notification tap.
 */
export async function getInitialNotification() {
  return await messaging().getInitialNotification();
}

/**
 * Listen for notification taps when app is in background.
 */
export function onNotificationOpenedApp(callback) {
  return messaging().onNotificationOpenedApp(callback);
}