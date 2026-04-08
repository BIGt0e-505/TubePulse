// Pre-seeded channels
export const DEFAULT_CHANNELS = [
  {
    handle: 'mattdoesartandstuff',
    name: 'MattO',
    channelId: 'UCDZThIzxlU2VzqO4ChHz_xg',
  },
  {
    handle: 'DNDrebeccaAFTG',
    name: 'DND Rebecca AFTG',
    channelId: 'UCZzoiefHjq3WTDorjSUqLfg',
  },
];

export const STORAGE_KEYS = {
  CHANNELS: 'tubepulse_channels',
  SETTINGS: 'tubepulse_settings',
  LAST_SEEN: 'tubepulse_last_seen',
  CHANNEL_CACHE: 'tubepulse_channel_cache',
  GENTLE_NOTIF_STATE: 'tubepulse_gentle_notif_state',
};

export const DEFAULT_SETTINGS = {
  tapAction: 'video', // 'video' or 'channel'
  pollIntervalMinutes: 30,
  notificationMode: 'persistent', // 'persistent' | 'gentle'
  dndEnabled: false,
  dndStart: '23:00',
  dndEnd: '08:00',
};

export const COLORS = {
  bg: '#0D0D0D',
  surface: '#1A1A1A',
  surfaceTranslucent: 'rgba(26, 26, 26, 0.85)',
  text: '#E0E0E0',
  textDim: '#666666',
  accent: '#4FC3F7',
  accentGlow: 'rgba(79, 195, 247, 0.3)',
  newDot: '#4FC3F7',
  border: '#2A2A2A',
  danger: '#EF5350',
};

export const BACKGROUND_FETCH_TASK = 'TUBEPULSE_BACKGROUND_FETCH';
