const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withForegroundService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Add FOREGROUND_SERVICE_DATA_SYNC permission for Android 14+
    const permissions = manifest['uses-permission'] || [];
    const hasPerm = permissions.some(
      (p) => p.$?.['android:name'] === 'android.permission.FOREGROUND_SERVICE_DATA_SYNC'
    );
    if (!hasPerm) {
      permissions.push({
        $: { 'android:name': 'android.permission.FOREGROUND_SERVICE_DATA_SYNC' },
      });
    }
    manifest['uses-permission'] = permissions;

    // Update the RNBackgroundActionsTask service with foregroundServiceType
    const app = manifest.application?.[0];
    if (app) {
      const services = app.service || [];
      const bgService = services.find(
        (s) => s.$?.['android:name'] === 'com.asterinet.react.bgactions.RNBackgroundActionsTask'
      );
      if (bgService) {
        bgService.$['android:foregroundServiceType'] = 'dataSync';
      } else {
        services.push({
          $: {
            'android:name': 'com.asterinet.react.bgactions.RNBackgroundActionsTask',
            'android:foregroundServiceType': 'dataSync',
          },
        });
      }
      app.service = services;
    }

    return config;
  });
};
