/**
 * TubePulse Cron Worker
 *
 * Runs every 5 minutes. Two jobs:
 *
 * 1. Nag cycle — scan devices for unwatched videos and re-notify
 *    based on mode (relentless/chill) and nag interval.
 *    DND batching: if DND just ended and multiple videos are pending,
 *    sends a single batched notification instead of one per video.
 *
 * 2. WebSub lease renewal — re-subscribe to channels whose
 *    WebSub leases are expiring soon.
 *
 * No YouTube RSS or API calls. All video detection happens via
 * WebSub push to the API worker.
 */

const GENTLE_REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── KV key prefixes ────────────────────────────────────────────────────

const KV_PREFIX_DEVICE = 'device:';
const KV_PREFIX_CHANNEL_META = 'channel:';
const KV_PREFIX_CHANNEL_FEED = 'feed:';
const KV_PREFIX_SUBSCRIPTION = 'sub:';

// ─── Helpers ────────────────────────────────────────────────────────────

async function getKV(kv, key) {
  return await kv.get(key, 'json');
}

async function putKV(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

// ─── DND logic ──────────────────────────────────────────────────────────

function isDndActive(dndStart, dndEnd) {
  const now = new Date();
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}

// ─── WebSub lease renewal ──────────────────────────────────────────────

const HUB_URL = 'https://pubsubhubbub.appspot.com/';
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

async function renewSubscriptions(env, callbackUrl) {
  const now = Date.now();
  const renewThreshold = now + 24 * 60 * 60 * 1000; // Renew if expiring within 24h

  const subKeys = [];
  let cursor = undefined;
  do {
    const list = await env.TUBEPULSE_KV.list({ prefix: KV_PREFIX_SUBSCRIPTION, cursor });
    for (const key of list.keys) {
      subKeys.push(key.name);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  let renewed = 0;

  for (const key of subKeys) {
    const sub = await getKV(env.TUBEPULSE_KV, key);
    if (!sub) continue;

    const channelId = key.replace(KV_PREFIX_SUBSCRIPTION, '');
    const expiresAt = sub.leaseExpires || 0;

    if (expiresAt > renewThreshold) continue;

    console.log(`[Cron] Renewing WebSub for ${channelId} (expires ${new Date(expiresAt).toISOString()})`);

    const feedUrl = `${FEED_TEMPLATE}${channelId}`;
    const body = new URLSearchParams({
      'hub.callback': callbackUrl,
      'hub.mode': 'subscribe',
      'hub.topic': feedUrl,
      'hub.verify': 'sync',
      'hub.lease_seconds': String(86400 * 5),
    });

    try {
      const resp = await fetch(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (resp.ok || resp.status === 202 || resp.status === 204) {
        console.log(`[Cron] Renewal request accepted for ${channelId}`);
        renewed++;
      } else {
        console.error(`[Cron] Renewal failed for ${channelId}: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[Cron] Renewal error for ${channelId}:`, err.message);
    }
  }

  return renewed;
}

// ─── FCM Push ───────────────────────────────────────────────────────────

async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const base64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const input = `${headerB64}.${payloadB64}`;

  const pemKey = sa.private_key;
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(input)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${input}.${signatureB64}`;

  const tokenResp = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

async function sendFCMPush(accessToken, projectId, fcmToken, payload) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            channel_id: payload.silent ? 'new-videos-silent' : 'new-videos',
            sound: payload.silent ? null : 'default',
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`FCM push failed for token ${fcmToken.slice(0, 10)}...: ${resp.status} ${errText}`);
    if (resp.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NotRegistered')) {
      return { sent: false, deadToken: true };
    }
    return { sent: false, deadToken: false };
  }

  return { sent: true, deadToken: false };
}

// ─── Main cron handler ──────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const startTime = Date.now();
    const nowMs = Date.now();
    console.log(`[Cron] Starting at ${new Date().toISOString()}`);

    // ── Job 1: WebSub lease renewal ──
    const callbackUrl = 'https://tubepulse-api.aaronjoakley55.workers.dev/websub';
    const renewed = await renewSubscriptions(env, callbackUrl);
    console.log(`[Cron] WebSub renewals: ${renewed}`);

    // ── Job 2: Nag cycle ──
    const deviceKeys = [];
    let cursor = undefined;
    do {
      const list = await env.TUBEPULSE_KV.list({ prefix: KV_PREFIX_DEVICE, cursor });
      for (const key of list.keys) {
        deviceKeys.push(key.name);
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    console.log(`[Cron] Found ${deviceKeys.length} devices`);

    if (deviceKeys.length === 0) {
      console.log('[Cron] Nothing to do. Done.');
      return;
    }

    let accessToken;
    try {
      accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('[Cron] Failed to get FCM access token:', err);
      return;
    }

    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = sa.project_id;

    const deadTokens = [];
    let pushCount = 0;

    for (const key of deviceKeys) {
      const device = await getKV(env.TUBEPULSE_KV, key);
      if (!device) continue;

      const fcmToken = device.fcmToken;
      if (!fcmToken) continue;
      let deviceUpdated = false;

      // Collect pending notifications per channel
      // { handle: { channelName, videos: [{videoId, title, link, type}] } }
      const pendingPerChannel = {};
      // Collect scheduled events
      const scheduledNotifications = [];

      for (const ch of device.channels || []) {
        if (!ch.channelId) continue;

        const handle = ch.handle;
        const feed = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + ch.channelId);
        const meta = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_META + ch.channelId);
        if (!feed?.videos) continue;

        const channelName = meta?.name || ch.name || handle;

        const perChannelEnabled = device.settings?.perChannelNotifications || false;
        const channelOverride = perChannelEnabled
          ? device.settings?.channelNotifSettings?.[handle]
          : null;
        const effectiveSettings = channelOverride
          ? { ...device.settings, ...channelOverride }
          : device.settings;

        const mode = effectiveSettings?.notificationMode || 'chill';
        const nagIntervalMs = (effectiveSettings?.nagInterval || 15) * 60 * 1000;

        const globalDndEnabled = device.settings?.dndEnabled || false;
        const globalDndActive = globalDndEnabled && isDndActive(
          device.settings?.dndStart || '22:00',
          device.settings?.dndEnd || '07:00'
        );
        const channelDndEnabled = effectiveSettings?.dndEnabled || false;
        const channelDndActive = channelDndEnabled && isDndActive(
          effectiveSettings?.dndStart || '22:00',
          effectiveSettings?.dndEnd || '07:00'
        );
        const dndActive = globalDndActive || channelDndActive;

        if (!device.lastSeen) device.lastSeen = {};
        if (!device.lastSeen[handle]) device.lastSeen[handle] = { seenIds: [] };

        const seenIds = new Set(device.lastSeen[handle].seenIds || []);

        // ── Scheduled events (premieres / scheduled livestreams) ──
        const scheduledState = device.lastSeen[handle].scheduledState || {};
        for (const [videoId, sched] of Object.entries(scheduledState)) {
          if (seenIds.has(videoId)) {
            delete scheduledState[videoId];
            deviceUpdated = true;
            continue;
          }

          const publishedTime = sched.publishedTime;
          const timeUntilLive = publishedTime - nowMs;

          // "Upcoming" notification: 1 nag interval before the event
          if (!sched.notified && timeUntilLive > 0 && timeUntilLive <= nagIntervalMs) {
            if (!dndActive) {
              const video = feed.videos.find((v) => v.videoId === videoId);
              scheduledNotifications.push({
                title: `${channelName} going live soon`,
                body: video?.title || 'Upcoming event',
                data: {
                  videoId,
                  channelName,
                  handle,
                  videoLink: video?.link || `https://www.youtube.com/watch?v=${videoId}`,
                  type: 'upcoming',
                },
              });
            }
            sched.notified = true;
            deviceUpdated = true;
          }

          // "Now available" notification: published time has passed
          if (!sched.wentLiveNotified && timeUntilLive <= 0) {
            if (!dndActive) {
              const video = feed.videos.find((v) => v.videoId === videoId);
              if (!pendingPerChannel[handle]) pendingPerChannel[handle] = { channelName, videos: [] };
              pendingPerChannel[handle].videos.push({
                videoId,
                title: video?.title || 'Now live',
                link: video?.link || `https://www.youtube.com/watch?v=${videoId}`,
                type: 'new_video',
              });
            }
            sched.wentLiveNotified = true;
            if (!device.lastSeen[handle].nagState) device.lastSeen[handle].nagState = {};
            device.lastSeen[handle].nagState[videoId] = {
              firstNotifiedAt: nowMs,
              lastNotifiedAt: nowMs,
            };
            delete scheduledState[videoId];
            deviceUpdated = true;
          }
        }
        if (device.lastSeen[handle].scheduledState !== scheduledState) {
          device.lastSeen[handle].scheduledState = scheduledState;
          deviceUpdated = true;
        }

        // ── Regular video nag cycle ──
        if (dndActive) continue; // Skip all regular nagging during DND

        for (const video of feed.videos) {
          if (seenIds.has(video.videoId)) continue;

          // Skip future-dated videos (scheduled, handled above)
          const publishedTime = video.published ? new Date(video.published).getTime() : 0;
          if (publishedTime > nowMs) continue;

          // ── Relentless mode ──
          if (mode === 'relentless') {
            const nagState = device.lastSeen[handle].nagState?.[video.videoId];

            if (!nagState) {
              // Not yet notified — send first notification now
              if (!device.lastSeen[handle].nagState) device.lastSeen[handle].nagState = {};
              device.lastSeen[handle].nagState[video.videoId] = {
                firstNotifiedAt: nowMs,
                lastNotifiedAt: nowMs,
              };
              deviceUpdated = true;

              if (!pendingPerChannel[handle]) pendingPerChannel[handle] = { channelName, videos: [] };
              pendingPerChannel[handle].videos.push({
                videoId: video.videoId,
                title: video.title,
                link: video.link,
                type: 'new_video',
              });
            } else {
              const elapsed = nowMs - (nagState.lastNotifiedAt || 0);
              if (elapsed < nagIntervalMs) continue;

              // Re-nag
              device.lastSeen[handle].nagState[video.videoId].lastNotifiedAt = nowMs;
              deviceUpdated = true;

              if (!pendingPerChannel[handle]) pendingPerChannel[handle] = { channelName, videos: [] };
              pendingPerChannel[handle].videos.push({
                videoId: video.videoId,
                title: video.title,
                link: video.link,
                type: 'new_video',
              });
            }
          }

          // ── Chill mode ──
          if (mode === 'chill') {
            const gentleState = device.lastSeen[handle].gentleState;

            if (!gentleState || gentleState.videoId !== video.videoId) {
              // First notification for this video
              device.lastSeen[handle].gentleState = {
                videoId: video.videoId,
                firstNotifiedAt: nowMs,
                lastRemindedAt: nowMs,
              };
              deviceUpdated = true;

              if (!pendingPerChannel[handle]) pendingPerChannel[handle] = { channelName, videos: [] };
              pendingPerChannel[handle].videos.push({
                videoId: video.videoId,
                title: video.title,
                link: video.link,
                type: 'new_video',
              });
            } else if (gentleState.videoId === video.videoId) {
              const elapsed = nowMs - (gentleState.lastRemindedAt || 0);
              if (elapsed < GENTLE_REMINDER_INTERVAL_MS) continue;

              // Reminder
              device.lastSeen[handle].gentleState.lastRemindedAt = nowMs;
              deviceUpdated = true;

              if (!pendingPerChannel[handle]) pendingPerChannel[handle] = { channelName, videos: [] };
              pendingPerChannel[handle].videos.push({
                videoId: video.videoId,
                title: video.title,
                link: video.link,
                type: 'new_video',
              });
            }
          }
        }
      }

      // ── Send collected notifications ──
      // Scheduled event notifications go first (individual)
      for (const notif of scheduledNotifications) {
        const result = await sendFCMPush(accessToken, projectId, fcmToken, notif);
        if (result.sent) pushCount++;
        else if (result.deadToken) { deadTokens.push(key); break; }
      }

      // Now send video notifications — batch if multiple channels have pending
      const channelHandles = Object.keys(pendingPerChannel);
      const totalVideos = channelHandles.reduce(
        (sum, h) => sum + pendingPerChannel[h].videos.length, 0
      );

      if (totalVideos === 0) {
        // No notifications needed
      } else if (totalVideos === 1) {
        // Single video — send individual notification
        const handle = channelHandles[0];
        const video = pendingPerChannel[handle].videos[0];
        const channelName = pendingPerChannel[handle].channelName;

        const result = await sendFCMPush(accessToken, projectId, fcmToken, {
          title: `${channelName} uploaded`,
          body: video.title,
          data: {
            videoId: video.videoId,
            channelName,
            handle,
            videoLink: video.link,
            type: video.type,
          },
          silent: false,
        });
        if (result.sent) pushCount++;
        else if (result.deadToken) deadTokens.push(key);
      } else {
        // Multiple videos — batch into one summary notification
        const channelNames = [...new Set(channelHandles.map((h) => pendingPerChannel[h].channelName))];
        const title = channelNames.length === 1
          ? `${channelNames[0]} — ${totalVideos} new videos`
          : `${totalVideos} new videos from ${channelNames.length} channels`;
        const body = channelHandles
          .map((h) => {
            const v = pendingPerChannel[h].videos;
            return v.length === 1
              ? `${pendingPerChannel[h].channelName}: ${v[0].title}`
              : `${pendingPerChannel[h].channelName}: ${v.length} videos`;
          })
          .join('\n');

        const result = await sendFCMPush(accessToken, projectId, fcmToken, {
          title,
          body,
          data: {
            type: 'batch',
            count: String(totalVideos),
            channels: String(channelNames.length),
          },
          silent: false,
        });
        if (result.sent) pushCount++;
        else if (result.deadToken) deadTokens.push(key);
      }

      // Prune stale nag states for videos no longer in the feed
      if (device.lastSeen) {
        for (const handle of Object.keys(device.lastSeen)) {
          const ch = device.channels?.find((c) => c.handle === handle);
          if (!ch?.channelId) continue;

          const feed = await getKV(env.TUBEPULSE_KV, KV_PREFIX_CHANNEL_FEED + ch.channelId);
          if (!feed?.videos) continue;

          const feedVideoIds = new Set(feed.videos.map((v) => v.videoId));
          const nagState = device.lastSeen[handle]?.nagState;

          if (nagState) {
            for (const videoId of Object.keys(nagState)) {
              if (!feedVideoIds.has(videoId)) {
                delete nagState[videoId];
                deviceUpdated = true;
              }
            }
          }
        }
      }

      if (deviceUpdated) {
        await putKV(env.TUBEPULSE_KV, key, device);
      }
    }

    // Prune dead tokens
    for (const key of deadTokens) {
      console.log(`[Cron] Pruning dead token: ${key}`);
      await env.TUBEPULSE_KV.delete(key);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Cron] Done in ${elapsed}ms. Nag pushes: ${pushCount}. Renewals: ${renewed}. Pruned: ${deadTokens.length}.`);
  },
};