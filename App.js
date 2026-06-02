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
import { registerDevice, markSeen, getDeviceId, subscribeChannel, updateSettings, bootstrapChannel } from './src/utils/api';
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
        // Register device with the server. We do this even if FCM is unavailable —
        // the device profile is what the preseed channel bootstrap subscribes against.
        // FCM token is a separate field on the profile and is set/updated below.
        try {
          await registerDevice(deviceId, fcmToken || null);
        } catch (e) {
          console.warn('Device register failed:', e);
        }

        if (fcmToken) {
          fcmTokenRef.current = fcmToken;
        }

        // Self-healing: on every launch, ensure every local channel is
        // subscribed on the server. This handles:
        //   - Fresh install (presedded channels not yet on server)
        //   - Upgrades from builds where init failed (e.g. v3.0.14 was
        //     shipped before the server accepted fcmToken=null, so init
        //     silently failed for no-permission users and the
        //     tubepulse_init_done flag was set anyway, blocking re-runs)
        //   - Drift between local state and server state
        // Idempotent: re-subscribing an already-subscribed channel is a
        // cheap no-op on the server side (alreadySubscribed: true).
        try {
          const { getChannels, getSettings } = require('./src/utils/storage');
          const localChannels = await getChannels();
          const localSettings = await getSettings();

          // Push settings to server
          try { await updateSettings(deviceId, localSettings); } catch (e) {}

          // Find local channels that have a channelId but no cache entry
          // (no avatar, no videos) — those are the ones that need work.
          // Using the local cache as the signal, not /feed, because
          // /feed requires a working device profile (which may not exist
          // yet on a brand-new install before this init runs).
          const { getChannelCache } = require('./src/utils/storage');
          const cache = await getChannelCache();
          const channelsNeedingInit = localChannels.filter((ch) => {
            if (!ch.channelId) return false;
            const cached = cache[ch.handle];
            return !cached || !cached.avatar || !cached.videos || cached.videos.length === 0;
          });

          if (channelsNeedingInit.length > 0) {
            console.log(`[Init] Bootstrapping ${channelsNeedingInit.length} channels: ${channelsNeedingInit.map((c) => c.handle).join(', ')}`);
            for (const ch of channelsNeedingInit) {
              // Subscribe (idempotent if already subscribed)
              try {
                await subscribeChannel(deviceId, ch.channelId);
              } catch (e) {
                console.warn(`[Init] Subscribe failed for ${ch.handle}:`, e);
              }

              // Bootstrap — fetches RSS + avatar from server
              try {
                const bootResult = await bootstrapChannel(deviceId, ch.channelId);
                if (bootResult?.ok && bootResult.videos?.length > 0) {
                  const { saveChannelCache, getLastSeen, saveLastSeen } = require('./src/utils/storage');
                  const freshCache = await getChannelCache();
                  const existingEntry = freshCache[ch.handle] || {};
                  freshCache[ch.handle] = {
                    name: bootResult.name || existingEntry.name || ch.name || ch.handle,
                    avatar: bootResult.avatar || existingEntry.avatar || null,
                    videos: bootResult.videos,
                    latestVideo: bootResult.videos[0] || null,
                    channelId: ch.channelId,
                    lastChecked: new Date().toISOString(),
                  };
                  await saveChannelCache(freshCache);

                  // Mark bootstrapped videos as seen so user isn't spammed
                  // about old content on first install
                  const lastSeen = await getLastSeen();
                  if (!lastSeen[ch.handle]) lastSeen[ch.handle] = { seenIds: [] };
                  const seenIds = new Set(lastSeen[ch.handle].seenIds || []);
                  for (const v of bootResult.videos) {
                    if (v.videoId) seenIds.add(v.videoId);
                  }
                  lastSeen[ch.handle].seenIds = [...seenIds];
                  await saveLastSeen(lastSeen);
                }
              } catch (e) {
                console.warn(`[Init] Bootstrap failed for ${ch.handle}:`, e);
              }
            }
            console.log(`[Init] Bootstrapped ${channelsNeedingInit.length} channels`);
          }
        } catch (e) {
          console.warn('[Init] Channel bootstrap failed:', e);
        }
        // Signal that init is complete (whether or not bootstrap ran)
        const { AsyncStorage: AS } = require('react-native');
        await AS.setItem('tubepulse_init_done', String(Date.now()));
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