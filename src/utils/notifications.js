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

export async function sendNewVideoNotification(channelName, videoTitle, videoId) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${channelName} uploaded`,
      body: videoTitle,
      data: { videoId, channelName },
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
      lightColor: '#4FC3F7',
    });
  }
}
