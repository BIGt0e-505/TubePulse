// tubepulse-rss — RSS shard worker (1 channel per invocation)
// Scheduled every minute. Each shard processes one channel from its slice.

import {
  key, getKV, putKV, putKVIfChanged, stableSort,
  fetchChannelRSS, classifyVideo, isDndActive,
  getCachedFcmAccessToken, sendFCMPush, cleanupDeadDevice,
  addToNagActive,
} from '../tubepulse-cron/shared.mjs';

const RSS_MAX_SHARDS = 3;

export default {
  async scheduled(event, env, ctx) {
    const shardIndex = Number(env.RSS_SHARD_INDEX || 0);
    const maxShards = Number(env.RSS_MAX_SHARDS || RSS_MAX_SHARDS);
    const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
    if (active.length === 0) return;

    const channels = stableSort(active);
    const activeShardCount = Math.min(maxShards, Math.max(1, Math.ceil(channels.length / 5)));
    if (shardIndex >= activeShardCount) return;

    const shardChannels = channels.filter((_, i) => i % activeShardCount === shardIndex);
    if (shardChannels.length === 0) return;

    const minuteSlot = Math.floor(Date.now() / 60000);
    const channel = shardChannels[minuteSlot % shardChannels.length];

    console.log(`[RSS] shard=${shardIndex}/${activeShardCount} channel=${channel}`);
    await pollSingleRssChannel(env, ctx, channel);
  },
};

async function pollSingleRssChannel(env, ctx, channelId) {
  const kv = env.TUBEPULSE_KV;

  const feed = await fetchChannelRSS(channelId);
  if (!feed || feed.entries.length === 0) return;

  const uploads = feed.entries.map((e) => ({
    videoId: e.videoId,
    title: e.title,
    published: e.published,
    thumbnail: e.thumbnail,
    link: e.link,
    channelTitle: feed.channelName,
    views: e.views,
    likes: e.likes,
    dislikes: e.dislikes,
  }));

  // Read existing recent list
  const prevRecent = await getKV(kv, key.channelRecent(channelId)) || [];
  const prevVideoIds = new Set(prevRecent.map((v) => v.videoId));
  const newVideos = uploads.filter((v) => !prevVideoIds.has(v.videoId));

  // Hourly view-count refresh for latest video
  const rssByVideoId = new Map(uploads.map((u) => [u.videoId, u]));
  const refreshedPrev = prevRecent.map((v) => v);
  let recentChanged = false;

  // Backfill likes/dislikes
  let backfilledAny = false;
  for (let i = 0; i < refreshedPrev.length; i++) {
    const v = refreshedPrev[i];
    const rss = rssByVideoId.get(v.videoId);
    if (!rss) continue;
    const needsLikes = v.likes === undefined || v.likes === null;
    const needsDislikes = v.dislikes === undefined || v.dislikes === null;
    if (!needsLikes && !needsDislikes) continue;
    refreshedPrev[i] = {
      ...v,
      likes: rss.likes != null ? String(rss.likes) : '0',
      dislikes: rss.dislikes != null ? String(rss.dislikes) : '0',
    };
    backfilledAny = true;
  }
  if (backfilledAny) {
    recentChanged = true;
    console.log(`[RSS] ${channelId}: backfilled likes/dislikes`);
  }

  const latest = prevRecent[0];
  const latestFromRss = latest && rssByVideoId.get(latest.videoId);
  const currentHour = Math.floor(Date.now() / 3600000);

  if (latest && latestFromRss) {
    const oldViews = parseInt(latest.views || '0', 10);
    const newViews = parseInt(latestFromRss.views || '0', 10);
    const viewsChanged = (
      !isNaN(oldViews) && !isNaN(newViews) &&
      currentHour !== latest.viewsLastCheckedHour &&
      (oldViews === 0 || Math.abs(newViews - oldViews) / Math.max(oldViews, 1) > 0.05)
    );
    const oldLikes = latest.likes;
    const newLikes = latestFromRss.likes != null ? String(latestFromRss.likes) : null;
    const oldDislikes = latest.dislikes;
    const newDislikes = latestFromRss.dislikes != null ? String(latestFromRss.dislikes) : null;
    const likesChanged = (
      currentHour !== latest.viewsLastCheckedHour &&
      ((newLikes != null && newLikes !== oldLikes) || (newDislikes != null && newDislikes !== oldDislikes))
    );

    if (viewsChanged) {
      refreshedPrev[0] = { ...latest, views: String(newViews), viewsLastCheckedHour: currentHour };
      recentChanged = true;
    } else if (latest.viewsLastCheckedHour === undefined) {
      refreshedPrev[0] = { ...latest, viewsLastCheckedHour: currentHour };
      recentChanged = true;
    }
    if (likesChanged) {
      refreshedPrev[0] = {
        ...refreshedPrev[0],
        likes: newLikes != null ? newLikes : (latest.likes || '0'),
        dislikes: newDislikes != null ? newDislikes : (latest.dislikes || '0'),
        likesLastCheckedHour: currentHour,
      };
      recentChanged = true;
    }
  }

  if (newVideos.length === 0) {
    if (recentChanged) {
      await putKVIfChanged(kv, key.channelRecent(channelId), refreshedPrev, prevRecent);
    }
    return;
  }

  // Build updated recent list with new videos
  const enrichedNew = newVideos.map((v) => {
    const rss = rssByVideoId.get(v.videoId) || v;
    return {
      videoId: v.videoId,
      title: v.title,
      publishedAt: v.published,
      thumbnail: v.thumbnail,
      type: classifyVideo(v),
      link: v.link,
      views: v.views || '0',
      likes: rss.likes != null ? String(rss.likes) : '0',
      dislikes: rss.dislikes != null ? String(rss.dislikes) : '0',
    };
  });

  const updatedRecent = [...enrichedNew, ...refreshedPrev].slice(0, 15);
  await putKVIfChanged(kv, key.channelRecent(channelId), updatedRecent, prevRecent);

  // Update channel meta
  const meta = await getKV(kv, key.channelMeta(channelId)) || {};
  let metaChanged = false;
  if (!meta.name && feed.channelName) { meta.name = feed.channelName; metaChanged = true; }
  if (meta.lastVideoId !== newVideos[0].videoId) { meta.lastVideoId = newVideos[0].videoId; metaChanged = true; }
  if (metaChanged) await putKVIfChanged(kv, key.channelMeta(channelId), meta);

  // Get subscribers
  const subs = await getKV(kv, key.channelSubs(channelId)) || [];
  if (subs.length === 0) return;

  // Get FCM access token (cached)
  let accessToken;
  try {
    accessToken = await getCachedFcmAccessToken(env);
  } catch (err) {
    console.error(`[RSS] FCM token error:`, err.message);
    return;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  const deadDevices = [];

  for (const deviceId of subs) {
    const [profile, settings, override] = await Promise.all([
      getKV(kv, key.deviceProfile(deviceId)),
      getKV(kv, key.deviceSettings(deviceId)),
      getKV(kv, key.deviceOverride(deviceId, channelId)),
    ]);

    if (!profile?.fcmToken) continue;
    if (override?.muted) continue;

    const effective = {
      mode: override?.mode || settings?.mode || 'chill',
      nagInterval: override?.nagInterval || settings?.nagInterval || 15,
      dndEnabled: settings?.dndEnabled || false,
      dndStart: settings?.dndStart || '22:00',
      dndEnd: settings?.dndEnd || '07:00',
      dndTimezone: settings?.dndTimezone || 'UTC',
      dndBypass: override?.dndBypass || false,
      tapAction: settings?.tapAction || 'video',
    };

    const state = await getKV(kv, key.deviceState(deviceId, channelId)) || {
      unwatched: [], lastNagAt: null, nagCount: 0,
    };

    let shouldNotify = true;
    let stateChanged = false;

    for (const video of newVideos) {
      if (!state.unwatched.includes(video.videoId)) {
        state.unwatched.push(video.videoId);
        stateChanged = true;
        addToNagActive(env, deviceId, channelId);
      }

      if (video.type === 'live_scheduled') {
        const publishedTime = new Date(video.publishedAt).getTime();
        const events = await getKV(kv, key.upcomingEvents()) || [];
        if (!events.some((e) => e.videoId === video.videoId)) {
          events.push({ channelId, videoId: video.videoId, scheduledFor: publishedTime, addedAt: Date.now() });
          await putKV(kv, key.upcomingEvents(), events);
        }
        continue;
      }

      const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
      const isLivestream = video.type === 'live';
      const bypassesDnd = effective.dndBypass || isLivestream;
      if (dndActive && !bypassesDnd) shouldNotify = false;
    }

    if (stateChanged) {
      await putKV(kv, key.deviceState(deviceId, channelId), state);
    }

    // Send FCM
    const notifyEntries = newVideos.filter((v) => v.type !== 'live_scheduled' && shouldNotify);
    if (notifyEntries.length > 0) {
      let notifPayload;
      const channelName = meta.name || channelId;
      if (notifyEntries.length === 1) {
        const v = notifyEntries[0];
        notifPayload = {
          title: `${channelName} uploaded`,
          body: v.title,
          data: { videoId: v.videoId, channelId, channelName, videoLink: v.link, type: v.type },
          tag: `video-${v.videoId}`,
        };
      } else {
        notifPayload = {
          title: `${channelName} - ${notifyEntries.length} new videos`,
          body: notifyEntries.map((v) => v.title).join('\n'),
          data: { type: 'batch', count: String(notifyEntries.length), channelId },
          tag: 'tubepulse-batch',
        };
      }
      const pushResult = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
      if (pushResult.deadToken) deadDevices.push(deviceId);
      if (pushResult.sent) {
        state.lastNagAt = Date.now();
        await putKV(kv, key.deviceState(deviceId, channelId), state);
      }
    }
  }

  for (const deviceId of [...new Set(deadDevices)]) {
    console.log(`[RSS] Pruning dead device: ${deviceId}`);
    ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
  }
}