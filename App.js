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
import { registerDevice, markSeen, getDeviceId, fetchFeed, subscribeChannel, updateSettings } from './src/utils/api';
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

          // Register device profile with API Worker (profile only — channels/settings are separate)
          await registerDevice(deviceId, fcmToken);

          // v2→v3 migration: if server doesn't know about this device's channels, re-subscribe them
          try {
            const feedResult = await fetchFeed(deviceId);
            if (feedResult.status === 404 || feedResult.error?.includes('not registered')) {
              console.log('[Migration] Server has no record — re-subscribing local channels');
              const { getChannels, getSettings } = require('./src/utils/storage');
              const localChannels = await getChannels();
              const localSettings = await getSettings();

              // Re-register with full profile
              await registerDevice(deviceId, fcmToken);

              // Push settings to server
              await updateSettings(deviceId, localSettings);

              // Re-subscribe each channel
              for (const ch of localChannels) {
                if (ch.channelId) {
                  try {
                    await subscribeChannel(deviceId, ch.channelId);
                  } catch (e) {
                    console.warn(`[Migration] Failed to subscribe ${ch.handle}:`, e);
                  }
                }
              }
              console.log(`[Migration] Re-subscribed ${localChannels.length} channels`);
            }
          } catch (e) {
            console.warn('[Migration] Migration check failed:', e);
          }
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
        await registerDevice(deviceId, newToken);
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
      if (!data?.videoId && !data?.channelId) return;

      try {
        const settings = await getSettings();
        const deviceId = deviceIdRef.current || await getDeviceId();

        if (data.type === 'batch' || settings.tapAction === 'channel') {
          // Channel tap or batch — mark all unwatched for this channel
          await markSeen(deviceId, data.channelId, [], true);

          // Update local state
          const lastSeen = await getLastSeen();
          const { getChannels, getChannelCache } = require('./src/utils/storage');
          const channels = await getChannels();
          const ch = channels.find((c) => c.channelId === data.channelId);
          const handle = ch?.handle;

          if (handle) {
            if (!lastSeen[handle]) lastSeen[handle] = { seenIds: [] };
            const cache = await getChannelCache();
            const channelVideos = cache[handle]?.videos || [];
            const existing = new Set(lastSeen[handle].seenIds || []);
            for (const v of channelVideos) {
              if (v.videoId) existing.add(v.videoId);
            }
            lastSeen[handle].seenIds = [...existing];
            await saveLastSeen(lastSeen);
          }

          // Open channel page
          if (handle) {
            Linking.openURL(`https://www.youtube.com/@${handle}`);
          }
        } else {
          // Video tap — mark single video
          await markSeen(deviceId, data.channelId, [data.videoId]);

          // Update local state
          const lastSeen = await getLastSeen();
          const { getChannels } = require('./src/utils/storage');
          const channels = await getChannels();
          const ch = channels.find((c) => c.channelId === data.channelId);
          const handle = ch?.handle;

          if (handle) {
            if (!lastSeen[handle]) lastSeen[handle] = { seenIds: [] };
            const seenIds = lastSeen[handle].seenIds || [];
            if (!seenIds.includes(data.videoId)) {
              lastSeen[handle].seenIds = [...seenIds, data.videoId];
              await saveLastSeen(lastSeen);
            }
          }

          // Open video
          if (data.videoLink) {
            Linking.openURL(data.videoLink);
          }
        }

        // Update widget
        try {
          const { requestWidgetUpdate } = require('react-native-android-widget');
          await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
        } catch {}
      } catch (e) {
        console.warn('Notification tap error:', e);
      }
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