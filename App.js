import React, { useEffect } from 'react';
import { StatusBar, Text, TouchableOpacity, Platform, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import HomeScreen from './src/screens/HomeScreen';
import ChannelsScreen from './src/screens/ChannelsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { COLORS } from './src/utils/constants';
import { getSettings, getLastSeen, saveLastSeen } from './src/utils/storage';

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

export default function App() {
  useEffect(() => {
    (async () => {
      try {
        const { requestPermissions, setupNotificationChannel } = require('./src/utils/notifications');
        await requestPermissions();
        await setupNotificationChannel();
        const settings = await getSettings();
        const { registerBackgroundFetch } = require('./src/utils/backgroundTask');
        await registerBackgroundFetch(settings.pollIntervalMinutes);
        // Start foreground service for reliable polling
        const { startForegroundService } = require('./src/utils/foregroundService');
        await startForegroundService();
      } catch (e) {
        console.warn('Init error:', e);
      }
    })();

    // Handle notification taps — mark video as seen, open URL, update widget
    const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const data = response.notification.request.content.data;
      if (data?.videoId && data?.handle) {
        try {
          const lastSeen = await getLastSeen();
          const ls = lastSeen[data.handle] || { seenIds: [] };
          const seenIds = ls.seenIds || [];
          if (!seenIds.includes(data.videoId)) {
            lastSeen[data.handle] = { seenIds: [...seenIds, data.videoId] };
            await saveLastSeen(lastSeen);
          }
          // Update widget
          try {
            const { requestWidgetUpdate } = require('react-native-android-widget');
            await requestWidgetUpdate({ widgetName: 'TubePulseWidget' });
          } catch {}
        } catch {}
      }
      // Open the video or channel based on settings
      try {
        const settings = await getSettings();
        const url = settings.tapAction === 'channel'
          ? `https://www.youtube.com/@${data.handle}`
          : data.videoLink;
        if (url) Linking.openURL(url);
      } catch {}
    });

    return () => subscription.remove();
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
