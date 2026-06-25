import React, { useEffect, useRef } from 'react';
import { StatusBar, Text, TouchableOpacity, Platform, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './src/screens/HomeScreen';
import ChannelsScreen from './src/screens/ChannelsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { COLORS } from './src/utils/constants';
import { getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from './src/utils/storage';
import { requestPermissionAndGetToken, onTokenRefresh, onForegroundMessage, onNotificationOpenedApp, getInitialNotification, setBackgroundMessageHandler } from './src/utils/fcm';
import { registerDevice, markSeen, getDeviceId, subscribeChannel, updateSettings, bootstrapChannel } from './src/utils/api';
import { setupNotificationChannel } from './src/utils/notifications';
import { ConfirmHost } from './src/components/Confirm';

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
// This runs when the app is in the background or killed and a push arrives.
// It needs to:
//   1. Pull the latest feed from the server (so the local cache has the new video)
//   2. Update the channel cache in AsyncStorage
//   3. Trigger a widget re-render so the home screen widget shows the new video
// Without this, the widget stays stale until the user opens the app.
setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('Background push received:', remoteMessage?.messageId, remoteMessage?.data?.videoId);
  try {
    const { getDeviceId, fetchFeed } = require('./src/utils/api');
    const deviceId = await getDeviceId();
    if (!deviceId) return;

    const result = await fetchFeed(deviceId);
    if (!result?.ok || !Array.isArray(result.channels)) return;

    // Get current local channels to resolve handle from channelId
    const { getChannels } = require('./src/utils/storage');
    const localChannels = await getChannels();
    const channelById = Object.fromEntries(
      localChannels.filter((c) => c.channelId).map((c) => [c.channelId, c])
    );

    const freshCache = await getChannelCache();
    let changed = false;
    for (const feed of result.channels) {
      const local = channelById[feed.channelId];
      const handle = local?.handle;
      if (!handle) continue;
      const existing = freshCache[handle] || {};

      // Detect new content: compare the first videoId (newest) and
      // check for any post IDs we haven't cached yet.  This replaces
      // the old "more videos than before" check which never triggered
      // because the server caps at 15 videos — a new upload pushes
      // one off the end, so the count stays the same.
      const serverFirstVideoId = feed.videos?.[0]?.videoId;
      const cachedFirstVideoId = existing.videos?.[0]?.videoId;
      const serverPostIds = new Set((feed.posts || []).map(p => p.activityId));
      const cachedPostIds = new Set((existing.posts || []).map(p => p.activityId));
      const hasNewPosts = [...serverPostIds].some(id => !cachedPostIds.has(id));
      const hasNewVideo = serverFirstVideoId && serverFirstVideoId !== cachedFirstVideoId;
      const hasAvatarGap = !existing.avatar && feed.meta?.avatarUrl;

      if (hasNewVideo || hasNewPosts || hasAvatarGap) {
        freshCache[handle] = {
          name: feed.meta?.name || existing.name || local.name || handle,
          avatar: feed.meta?.avatarUrl || existing.avatar || null,
          videos: feed.videos || existing.videos || [],
          // Preserve posts from the server response, falling back to
          // any existing posts we already had (the server always
          // returns the current set, so this replaces rather than
          // merges — which is correct).
          posts: feed.posts || existing.posts || [],
          latestVideo: (feed.videos || [])[0] || existing.latestVideo || null,
          channelId: feed.channelId,
          lastChecked: new Date().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) {
      await saveChannelCache(freshCache);
    }

    // Always trigger a widget update — the widget task handler will read
    // whatever is in the cache and re-render. If the cache is unchanged,
    // the widget still re-renders to a no-op state but at least stays
    // consistent.
    try {
      const { requestWidgetUpdate } = require('react-native-android-widget');
      await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
    } catch {}
  } catch (e) {
    console.warn('Background push handler failed:', e);
  }
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
                  // Only keep the latest video on first install/bootstrap.
                  // The server retains the full 15-video recent list for
                  // future diffing; the client only needs the latest to
                  // show in the feed/widget. Everything is marked as
                  // seen so the user isn't spammed with old content.
                  const latestOnly = [bootResult.videos[0]];
                  freshCache[ch.handle] = {
                    name: bootResult.name || existingEntry.name || ch.name || ch.handle,
                    avatar: bootResult.avatar || existingEntry.avatar || null,
                    videos: latestOnly,
                    latestVideo: latestOnly[0] || null,
                    channelId: ch.channelId,
                    lastChecked: new Date().toISOString(),
                  };
                  await saveChannelCache(freshCache);

                  // Mark the latest video as seen locally
                  const lastSeen = await getLastSeen();
                  if (!lastSeen[ch.handle]) lastSeen[ch.handle] = { seenIds: [] };
                  const seenIds = new Set(lastSeen[ch.handle].seenIds || []);
                  if (latestOnly[0]?.videoId) seenIds.add(latestOnly[0].videoId);
                  lastSeen[ch.handle].seenIds = [...seenIds];
                  await saveLastSeen(lastSeen);

                  // Mark ALL existing videos as seen on the server too,
                  // so the /feed response won't flag old uploads as
                  // unwatched. Only genuinely new uploads (detected by
                  // the cron after this point) will appear as "New".
                  try {
                    const { markSeen } = require('./src/utils/api');
                    await markSeen(deviceId, ch.channelId, [], true);
                  } catch (e) {
                    console.warn(`[Init] markSeen clearAll failed for ${ch.handle}:`, e);
                  }
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
      if (!data?.videoId && !data?.channelId && !data?.activityId) return;

      try {
        const settings = await getSettings();
        const deviceId = deviceIdRef.current || await getDeviceId();
        const isPost = data.type === 'post' && data.activityId;
        const isPrewarn = data.type === 'prewarn' && data.videoId;

        if (isPost) {
          // Post taps always mark the post as seen and open the
          // community tab. The user's tapAction preference doesn't
          // change post behaviour — there's no per-post tapAction to
          // apply (videos and posts share the same screen).
          const postKey = `post:${data.activityId}`;
          await markSeen(deviceId, data.channelId, [postKey]);

          const { getChannels } = require('./src/utils/storage');
          const channels = await getChannels();
          const ch = channels.find((c) => c.channelId === data.channelId);
          const handle = ch?.handle;

          if (handle) {
            const lastSeen = await getLastSeen();
            if (!lastSeen[handle]) lastSeen[handle] = { seenIds: [] };
            const seenIds = lastSeen[handle].seenIds || [];
            if (!seenIds.includes(postKey)) {
              lastSeen[handle].seenIds = [...seenIds, postKey];
              await saveLastSeen(lastSeen);
            }

            const cache = await getChannelCache();
            const cached = cache[handle];
            if (cached?.posts?.some((p) => p.activityId === data.activityId && p.unwatched)) {
              const updatedCache = {
                ...cache,
                [handle]: {
                  ...cached,
                  posts: cached.posts.map((p) =>
                    p.activityId === data.activityId ? { ...p, unwatched: false } : p
                  ),
                },
              };
              await saveChannelCache(updatedCache);
            }
          }

          Linking.openURL(`https://www.youtube.com/channel/${data.channelId}/community`);
        } else if (isPrewarn) {
          // Prewarn taps open the scheduled video's watch URL. We do
          // NOT mark it as seen — the user is just being reminded it
          // exists; the "live now" push will fire later and the nag
          // cycle should still prompt if they ignore it.
          Linking.openURL(`https://www.youtube.com/watch?v=${data.videoId}`);
        } else if (data.type === 'batch' || settings.tapAction === 'channel') {
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
            const cached = cache[handle] || {};
            const channelVideos = cached.videos || [];
            const channelPosts = cached.posts || [];
            const existing = new Set(lastSeen[handle].seenIds || []);
            for (const v of channelVideos) {
              if (v.videoId) existing.add(v.videoId);
            }
            for (const p of channelPosts) {
              if (p.activityId) existing.add(`post:${p.activityId}`);
            }
            lastSeen[handle].seenIds = [...existing];
            await saveLastSeen(lastSeen);

            if (channelVideos.some((v) => v.unwatched) || channelPosts.some((p) => p.unwatched)) {
              await saveChannelCache({
                ...cache,
                [handle]: {
                  ...cached,
                  videos: channelVideos.map((v) => ({ ...v, unwatched: false })),
                  posts: channelPosts.map((p) => ({ ...p, unwatched: false })),
                },
              });
            }
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
      {/* ConfirmHost is a global modal host. Any `confirm()` call from
          anywhere in the app will resolve here, drawing the themed
          ConfirmDialog above whatever screen is currently visible. */}
      <ConfirmHost />
    </GestureHandlerRootView>
  );
}