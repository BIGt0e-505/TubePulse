import React, { useEffect, useRef } from 'react';
import { StatusBar, Text, TouchableOpacity, Platform, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './src/screens/HomeScreen';
import ChannelsScreen from './src/screens/ChannelsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { COLORS } from './src/utils/constants';
import { getSettings, getLastSeen, saveLastSeen } from './src/utils/storage';
import { requestPermissionAndGetToken, onTokenRefresh, onForegroundMessage, onNotificationOpenedApp, getInitialNotification, setBackgroundMessageHandler } from './src/utils/fcm';
import { registerDevice, markSeen, getDeviceId } from './src/utils/api';
import { setupNotificationChannel } from './src/utils/notifications';

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: COLORS.bg },
  headerTintColor: COLORS.text,
  headerTitleStyle: { fontWeight: '600', fontSize: 17 },
  contentStyle: { backgroundColor: COLORS.bg },
};

function HeaderButton({ title, onPress, style }) {
  return (
    <TouchableOpacity onPress={onPress} style={style}>
      <Text style={{ color: COLORS.accent, fontSize: 14, fontWeight: '500' }}>
        {title}
      </Text>
    </TouchableOpacity>
  );
}

// Background message handler — must be registered at top level
setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('Background push received:', remoteMessage.messageId);
});

export default function App() {
  const fcmTokenRef = useRef(null);
  const deviceIdRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        // Set up Android notification channels
        await setupNotificationChannel();

        // Get persistent device ID
        const deviceId = await getDeviceId();
        deviceIdRef.current = deviceId;

        // Request permission and get FCM token
        const fcmToken = await requestPermissionAndGetToken();
        if (fcmToken) {
          fcmTokenRef.current = fcmToken;

          // Register with API Worker
          const { getChannels, getSettings } = require('./src/utils/storage');
          const [channels, settings] = await Promise.all([
            getChannels(),
            getSettings(),
          ]);

          await registerDevice(deviceId, fcmToken, channels, settings);
        }
      } catch (e) {
        console.warn('Init error:', e);
      }
    })();

    // Handle token refresh — re-register with updated FCM token
    const tokenUnsubscribe = onTokenRefresh(async (newToken) => {
      fcmTokenRef.current = newToken;
      try {
        const deviceId = deviceIdRef.current || await getDeviceId();
        const { getChannels, getSettings } = require('./src/utils/storage');
        const [channels, settings] = await Promise.all([
          getChannels(),
          getSettings(),
        ]);
        await registerDevice(deviceId, newToken, channels, settings);
      } catch (e) {
        console.warn('Token refresh re-register failed:', e);
      }
    });

    // Handle foreground messages
    const foregroundUnsubscribe = onForegroundMessage(async (remoteMessage) => {
      console.log('Foreground push:', remoteMessage?.data?.videoId);
    });

    // Handle notification tap (app opened from notification)
    const handleNotificationTap = async (remoteMessage) => {
      const data = remoteMessage?.data;
      if (!data?.videoId || !data?.handle) return;

      try {
        const settings = await getSettings();
        const deviceId = deviceIdRef.current || await getDeviceId();

        if (settings.tapAction === 'channel') {
          await markSeen(deviceId, data.channelId, [], true);
        } else {
          await markSeen(deviceId, data.channelId, [data.videoId]);
        }

        // Update local state
        const lastSeen = await getLastSeen();
        if (!lastSeen[data.handle]) lastSeen[data.handle] = { seenIds: [] };

        if (settings.tapAction === 'channel') {
          const { getChannels, getChannelCache } = require('./src/utils/storage');
          const channels = await getChannels();
          const ch = channels.find((c) => c.handle === data.handle);
          if (ch?.channelId) {
            const cache = await getChannelCache();
            const channelVideos = cache[data.handle]?.videos || [];
            const existing = new Set(lastSeen[data.handle].seenIds || []);
            for (const v of channelVideos) {
              if (v.videoId) existing.add(v.videoId);
            }
            lastSeen[data.handle].seenIds = [...existing];
          }
        } else {
          const seenIds = lastSeen[data.handle].seenIds || [];
          if (!seenIds.includes(data.videoId)) {
            lastSeen[data.handle].seenIds = [...seenIds, data.videoId];
          }
        }

        delete lastSeen[data.handle]?.gentleState;
        delete lastSeen[data.handle]?.nagState;
        await saveLastSeen(lastSeen);

        // Update widget
        try {
          const { requestWidgetUpdate } = require('react-native-android-widget');
          await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
        } catch {}
      } catch {}

      // Open the video or channel based on settings
      try {
        const settings = await getSettings();
        const url = settings.tapAction === 'channel'
          ? `https://www.youtube.com/@${data.handle}`
          : data.videoLink;
        if (url) Linking.openURL(url);
      } catch {}
    };

    // Check if app was opened from a notification (cold start)
    getInitialNotification().then((remoteMessage) => {
      if (remoteMessage) {
        handleNotificationTap(remoteMessage);
      }
    });

    // Listen for notification taps (warm start)
    const tapUnsubscribe = onNotificationOpenedApp(handleNotificationTap);

    return () => {
      tokenUnsubscribe();
      foregroundUnsubscribe();
      tapUnsubscribe();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <NavigationContainer
        theme={{
          ...DefaultTheme,
          dark: true,
          colors: {
            ...DefaultTheme.colors,
            primary: COLORS.accent,
            background: COLORS.bg,
            card: COLORS.bg,
            text: COLORS.text,
            border: COLORS.border,
            notification: COLORS.accent,
          },
        }}
      >
        <Stack.Navigator screenOptions={screenOptions}>
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={({ navigation }) => ({
              title: 'TubePulse',
              headerRight: () => (
                <>
                  <HeaderButton title="Channels" onPress={() => navigation.navigate('Channels')} />
                  <HeaderButton title="Settings" onPress={() => navigation.navigate('Settings')} style={{ marginLeft: 14 }} />
                </>
              ),
            })}
          />
          <Stack.Screen name="Channels" component={ChannelsScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}