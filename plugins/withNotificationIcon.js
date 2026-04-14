/**
 * withNotificationIcon.js
 * Config plugin that copies pre-generated monochrome notification icons
 * into all Android drawable density buckets during prebuild.
 *
 * The icons are stored in assets/notification-icons/ and were extracted
 * from the v1.0.37 APK (the white disc with play triangle cutout).
 */

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DENSITIES = [
  { dir: 'drawable-mdpi',    file: 'mdpi.png'    },
  { dir: 'drawable-hdpi',     file: 'hdpi.png'     },
  { dir: 'drawable-xhdpi',    file: 'xhdpi.png'    },
  { dir: 'drawable-xxhdpi',  file: 'xxhdpi.png'  },
  { dir: 'drawable-xxxhdpi', file: 'xxxhdpi.png' },
  { dir: 'drawable',          file: 'fallback.png'  },
];

const ICON_NAME = 'notification_icon.png';

module.exports = function withNotificationIcon(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const iconsDir = path.join(projectRoot, 'assets', 'notification-icons');
      const resDir = path.join(
        projectRoot,
        'android', 'app', 'src', 'main', 'res'
      );

      for (const { dir, file } of DENSITIES) {
        const srcFile = path.join(iconsDir, file);
        if (!fs.existsSync(srcFile)) {
          console.warn(`  ✗ Missing icon source: ${srcFile}`);
          continue;
        }

        const drawableDir = path.join(resDir, dir);
        fs.mkdirSync(drawableDir, { recursive: true });

        const destFile = path.join(drawableDir, ICON_NAME);
        fs.copyFileSync(srcFile, destFile);
        console.log(`  ✓ notification_icon.png → ${dir}`);
      }

      return config;
    },
  ]);
};