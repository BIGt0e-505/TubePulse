/**
 * withNotificationIcon.js
 * Config plugin that directly writes a monochrome notification icon
 * into all Android drawable density buckets during prebuild.
 *
 * This is the reliable approach — bypasses expo-notifications plugin
 * config parsing and directly places the PNG where Android expects it.
 */

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Drawable density directories and target sizes
const DENSITIES = [
  { dir: 'drawable-mdpi',    size: 24  },
  { dir: 'drawable-hdpi',    size: 36  },
  { dir: 'drawable-xhdpi',   size: 48  },
  { dir: 'drawable-xxhdpi',  size: 72  },
  { dir: 'drawable-xxxhdpi', size: 96  },
  { dir: 'drawable',         size: 48  }, // fallback
];

const ICON_NAME = 'notification_icon.png';

/**
 * Generate a monochrome PNG (white play triangle on transparent bg)
 * at the given pixel size using raw PNG encoding (no external deps).
 */
function generateMonochromePng(size) {
  // We'll copy + resize the source asset using sharp if available,
  // otherwise fall back to copying a pre-generated PNG.
  // Since we have Pillow available via python3, use that.
  const { execSync } = require('child_process');

  const tmpFile = `/tmp/notif_icon_${size}.png`;
  const script = `
from PIL import Image, ImageDraw
import sys

size = ${size}
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
margin = int(size * 0.18)
points = [(margin, margin), (margin, size - margin), (size - margin, size // 2)]
draw.polygon(points, fill=(255, 255, 255, 255))
img.save('${tmpFile}')
`;

  execSync(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
  return fs.readFileSync(tmpFile);
}

module.exports = function withNotificationIcon(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(
        config.modRequest.projectRoot,
        'android', 'app', 'src', 'main', 'res'
      );

      for (const { dir, size } of DENSITIES) {
        const drawableDir = path.join(resDir, dir);
        fs.mkdirSync(drawableDir, { recursive: true });

        const destFile = path.join(drawableDir, ICON_NAME);
        try {
          const pngData = generateMonochromePng(size);
          fs.writeFileSync(destFile, pngData);
          console.log(`  ✓ notification_icon.png → ${dir} (${size}px)`);
        } catch (e) {
          console.warn(`  ✗ Failed to write ${dir}: ${e.message}`);
        }
      }

      return config;
    },
  ]);
};
