// Read-only audit script for TubePulse RSS deletion-spam state.
//
// Run inside the wrangler environment with KV access, or point it at a
// dumped KV state directory. It never mutates anything.
//
// Usage:
//   npx wrangler dev --test-mode   # not supported directly; use a debug route
//
// This script is intended to be invoked by a worker debug route or a
// local KV dump. It does not contain secrets. It expects an `env` object
// with a `TUBEPULSE_KV` binding and a list of suspect channel IDs.

// Affected channels from the bug report.
const SUSPECT_CHANNELS = [
  'UCxxxxxxxxxxxxxxxxxxxxxx', // replace with Undert0e channel ID
  'UCyyyyyyyyyyyyyyyyyyyyyy', // replace with DND Rebecca AFTG channel ID
];

// Example device/channel IDs to inspect. Override when invoking.
const SUSPECT_DEVICE_CHANNEL_PAIRS = [
  // { deviceId: '...', channelId: '...' }
];

export async function auditRssDeletionSpam(env, options = {}) {
  const kv = env.TUBEPULSE_KV;
  const suspectChannels = options.channels || SUSPECT_CHANNELS;
  const suspectPairs = options.pairs || SUSPECT_DEVICE_CHANNEL_PAIRS;
  const now = Date.now();

  const report = {
    generatedAt: new Date(now).toISOString(),
    channels: [],
    deviceStates: [],
    nagActive: [],
    proposedCleanup: [],
  };

  // 1. Inspect suspect channels: known:videos and recent.
  for (const channelId of suspectChannels) {
    const [known, recent, meta, subs] = await Promise.all([
      kv.get(`channel:${channelId}:known:videos`, 'json'),
      kv.get(`channel:${channelId}:recent`, 'json'),
      kv.get(`channel:${channelId}:meta`, 'json'),
      kv.get(`channel:${channelId}:subscribers`, 'json'),
    ]);

    const recentIds = new Set((recent || []).map((v) => v.videoId));
    const knownIds = new Set((known?.ids || []));
    const highWatermarkAt = known?.highWatermarkAt || null;
    const knownNotInRecent = [...knownIds].filter((id) => !recentIds.has(id));
    const recentNotKnown = (recent || []).filter((v) => !knownIds.has(v.videoId));

    report.channels.push({
      channelId,
      subscriberCount: (subs || []).length,
      meta,
      highWatermarkAt,
      knownCount: knownIds.size,
      recentCount: (recent || []).length,
      knownNotInRecent,
      recentNotKnown: recentNotKnown.map((v) => ({ videoId: v.videoId, publishedAt: v.publishedAt })),
    });
  }

  // 2. Inspect device/channel unwatched state.
  const inspectedPairs = suspectPairs.length > 0
    ? suspectPairs
    : await gatherPairsFromNagActive(kv);

  for (const { deviceId, channelId } of inspectedPairs) {
    const [state, recent, known] = await Promise.all([
      kv.get(`device:${deviceId}:state:${channelId}`, 'json'),
      kv.get(`channel:${channelId}:recent`, 'json'),
      kv.get(`channel:${channelId}:known:videos`, 'json'),
    ]);

    const unwatched = state?.unwatched || [];
    const videoIds = unwatched.filter((id) => !id.startsWith('post:'));
    const postIds = unwatched.filter((id) => id.startsWith('post:'));
    const highWatermarkAt = known?.highWatermarkAt;
    const knownIds = new Set(known?.ids || []);
    const recentMap = new Map((recent || []).map((v) => [v.videoId, v.publishedAt]));

    const classified = videoIds.map((id) => {
      const inRecent = recentMap.has(id);
      const inKnown = knownIds.has(id);
      const publishedAt = recentMap.get(id) || null;
      let reason;
      if (inKnown) reason = 'known-id';
      else if (!publishedAt) reason = 'missing-from-recent';
      else if (!highWatermarkAt) reason = 'no-channel-watermark';
      else if (new Date(publishedAt).getTime() <= new Date(highWatermarkAt).getTime()) {
        reason = 'at-or-below-watermark';
      } else {
        reason = 'likely-genuine';
      }
      return { id, publishedAt, inRecent, inKnown, reason };
    });

    const spam = classified.filter((c) => c.reason !== 'likely-genuine');
    const genuine = classified.filter((c) => c.reason === 'likely-genuine');

    report.deviceStates.push({
      deviceId,
      channelId,
      unwatchedCount: unwatched.length,
      videoCount: videoIds.length,
      postCount: postIds.length,
      spam,
      genuine,
    });

    if (spam.length > 0) {
      report.proposedCleanup.push({
        deviceId,
        channelId,
        action: 'remove-spam-video-ids',
        idsToRemove: spam.map((c) => c.id),
        keep: genuine.map((c) => c.id),
        removeNagActive: genuine.length === 0 && postIds.length === 0,
      });
    }
  }

  // 3. Inspect nag:active for affected device/channel pairs.
  const nagActive = (await kv.get('nag:active', 'json')) || [];
  for (const entry of nagActive) {
    const [deviceId, channelId] = entry.split('|');
    const isSuspectChannel = suspectChannels.includes(channelId);
    const isSuspectPair = inspectedPairs.some((p) => p.deviceId === deviceId && p.channelId === channelId);
    if (isSuspectChannel || isSuspectPair) {
      const state = await kv.get(`device:${deviceId}:state:${channelId}`, 'json');
      const unwatchedCount = state?.unwatched?.length || 0;
      report.nagActive.push({
        entry,
        deviceId,
        channelId,
        unwatchedCount,
        recommendation: unwatchedCount === 0 ? 'remove-entry' : 'keep-entry',
      });
    }
  }

  return report;
}

async function gatherPairsFromNagActive(kv) {
  const nagActive = (await kv.get('nag:active', 'json')) || [];
  const pairs = [];
  for (const entry of nagActive) {
    const parts = entry.split('|');
    if (parts.length === 2) {
      pairs.push({ deviceId: parts[0], channelId: parts[1] });
    }
  }
  return pairs;
}

// If run directly with a local KV dump, pretty-print the report.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.error('This script is a library for use inside a worker debug route or with a KV dump.');
  console.error('It does not connect to live KV on its own. Provide an env-like object to auditRssDeletionSpam().');
}
