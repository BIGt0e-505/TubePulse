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
import { registerDevice, markSeen } from './src/utils/api';
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
  // FCM handles displaying the notification. We just log it.
  console.log('Background push received:', remoteMessage.messageId);
});

export default function App() {
  const fcmTokenRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        // Set up Android notification channels
        await setupNotificationChannel();

        // Request permission and get FCM token
        const token = await requestPermissionAndGetToken();
        if (token) {
          fcmTokenRef.current = token;

          // Register with API Worker
          const { getChannels, getSettings } = require('./src/utils/storage');
          const [channels, settings] = await Promise.all([
            getChannels(),
            getSettings(),
          ]);

          await registerDevice(token, channels, settings);
        }
      } catch (e) {
        console.warn('Init error:', e);
      }
    })();

    // Handle token refresh — re-register with API Worker
    const tokenUnsubscribe = onTokenRefresh(async (newToken) => {
      fcmTokenRef.current = newToken;
      try {
        const { getChannels, getSettings } = require('./src/utils/storage');
        const [channels, settings] = await Promise.all([
          getChannels(),
          getSettings(),
        ]);
        await registerDevice(newToken, channels, settings);
      } catch (e) {
        console.warn('Token refresh re-register failed:', e);
      }
    });

    // Handle foreground messages — update UI if on Home screen
    const foregroundUnsubscribe = onForegroundMessage(async (remoteMessage) => {
      console.log('Foreground push:', remoteMessage?.data?.videoId);
      // Foreground messages don't auto-display — the notification tray will handle it
      // for background, but in foreground we just log. The user can pull-to-refresh.
    });

    // Handle notification tap (app opened from notification)
    const handleNotificationTap = async (remoteMessage) => {
      const data = remoteMessage?.data;
      if (!data?.videoId || !data?.handle) return;

      try {
        // Mark video as seen locally
        const lastSeen = await getLastSeen();
        const ls = lastSeen[data.handle] || { seenIds: [] };
        const seenIds = ls.seenIds || [];
        if (!seenIds.includes(data.videoId)) {
          lastSeen[data.handle] = { seenIds: [...seenIds, data.videoId] };
          await saveLastSeen(lastSeen);
        }

        // Mark seen on server
        if (fcmTokenRef.current) {
          await markSeen(fcmTokenRef.current, data.handle, [data.videoId]);
        }

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