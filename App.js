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

          // Clear init flag from previous session
          const { AsyncStorage: ASInit } = require('react-native');
          await ASInit.removeItem('tubepulse_init_done');

          // After registering, ensure local channels are subscribed on the server
          // This handles both fresh install and v2→v3 migration
          try {
            const { getChannels, getSettings } = require('./src/utils/storage');
            const localChannels = await getChannels();
            const localSettings = await getSettings();

            // Push settings to server
            try { await updateSettings(deviceId, localSettings); } catch (e) {}

            // Subscribe any local channels that aren't on the server yet
            const feedResult = await fetchFeed(deviceId);
            const serverChannelIds = (feedResult.ok && feedResult.channels)
              ? feedResult.channels.map((c) => c.channelId)
              : [];

            const missingChannels = localChannels.filter(
              (ch) => ch.channelId && !serverChannelIds.includes(ch.channelId)
            );

            if (missingChannels.length > 0) {
              console.log(`[Init] Subscribing ${missingChannels.length} channels to server`);
              for (const ch of missingChannels) {
                if (ch.channelId) {
                  try {
                    const subResult = await subscribeChannel(deviceId, ch.channelId);
                    // Write subscribe result directly to local cache so HomeScreen sees it
                    if (subResult?.ok && subResult.channel) {
                      const { getChannelCache, saveChannelCache } = require('./src/utils/storage');
                      const cache = await getChannelCache();
                      const handle = ch.handle;
                      const videos = (subResult.channel.recent || []).map((v) => ({
                        videoId: v.videoId,
                        title: v.title,
                        published: v.publishedAt,
                        thumbnail: v.thumbnail,
                        link: v.link,
                        type: v.type,
                        unwatched: false,
                      }));
                      cache[handle] = {
                        name: subResult.channel.meta?.name || ch.name || handle,
                        avatar: subResult.channel.meta?.avatarUrl || null,
                        videos,
                        latestVideo: videos[0] || null,
                        channelId: ch.channelId,
                        lastChecked: new Date().toISOString(),
                      };
                      await saveChannelCache(cache);
                    }
                  } catch (e) {
                    console.warn(`[Init] Failed to subscribe ${ch.handle}:`, e);
                  }
                }
              }
              console.log(`[Init] Subscribed ${missingChannels.length} channels`);
            }
          } catch (e) {
            console.warn('[Init] Channel subscription failed:', e);
          }
          // Signal that init is complete (whether or not migration ran)
          const { AsyncStorage: AS } = require('react-native');
          await AS.setItem('tubepulse_init_done', String(Date.now()));
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