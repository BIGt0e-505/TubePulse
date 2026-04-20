/**
 * TubePulse Cron Worker — v3.0 (channel-first architecture)
 *
 * Three scheduled jobs:
 *   */5  — Upcoming events: check time buckets for scheduled livestreams
 *   */15 — Nag cycle: check nag buckets, re-notify unwatched videos
 *   0 */6 — Lease renewal: renew WebSub subscriptions expiring within 24h
 *
 * Architecture: time-bucket driven. No KV.list() calls anywhere.
 * Each job reads the bucket for "now" and processes entries.
 */

// ─── Key builders (must match API worker) ────────────────────────────────

const key = {
  channelMeta:      (channelId) => `channel:${channelId}:meta`,
  channelSubs:      (channelId) => `channel:${channelId}:subscribers`,
  channelWebsub:    (channelId) => `channel:${channelId}:websub`,
  channelRecent:    (channelId) => `channel:${channelId}:recent`,
  deviceProfile:    (deviceId)  => `device:${deviceId}:profile`,
  deviceSettings:   (deviceId)  => `device:${deviceId}:settings`,
  deviceOverride:   (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState:      (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  upcoming:         (bucket)    => `upcoming:${bucket}`,
  nag:              (bucket)    => `nag:${bucket}`,
  channelsActive:   ()          => `channels:active`,
};

async function getKV(kv, k) { return await kv.get(k, 'json'); }
async function putKV(kv, k, value) { await kv.put(k, JSON.stringify(value)); }

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

// ─── Time bucket helpers ────────────────────────────────────────────────

function currentUpcomingBucket() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16);
}

function currentNagBucket() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16);
}

function nagBucket(timestampMs) {
  const d = new Date(timestampMs);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16);
}

// ─── WebSub lease renewal ──────────────────────────────────────────────

const HUB_URL = 'https://pubsubhubbub.appspot.com/';
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

async function renewSubscriptions(env, callbackUrl) {
  const now = Date.now();
  const renewThreshold = now + 24 * 60 * 60 * 1000; // 24h ahead

  const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
  let renewed = 0;

  for (const channelId of active) {
    const subState = await getKV(env.TUBEPULSE_KV, key.channelWebsub(channelId));
    if (!subState) continue;

    const expiresAt = subState.leaseExpiresAt || 0;
    if (expiresAt > renewThreshold) continue; // Not expiring soon

    console.log(`[Lease] Renewing ${channelId} (expires ${new Date(expiresAt).toISOString()})`);

    const feedUrl = `${FEED_TEMPLATE}${channelId}`;
    const body = new URLSearchParams({
      'hub.callback': callbackUrl,
      'hub.mode': 'subscribe',
      'hub.topic': feedUrl,
      'hub.verify': 'sync',
      'hub.lease_seconds': String(86400 * 5),
    });

    if (subState.hmacSecret) {
      body.set('hub.secret', subState.hmacSecret);
    }

    try {
      const resp = await fetch(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (resp.ok || resp.status === 202 || resp.status === 204) {
        console.log(`[Lease] Renewal accepted for ${channelId}`);
        renewed++;
      } else {
        console.error(`[Lease] Renewal failed for ${channelId}: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[Lease] Renewal error for ${channelId}:`, err.message);
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
    'pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
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
            tag: payload.tag || 'tubepulse',
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

// ─── Job 1: Upcoming events (every 5 min) ───────────────────────────────

async function runUpcomingCron(env) {
  const bucket = currentUpcomingBucket();
  const entries = await getKV(env.TUBEPULSE_KV, key.upcoming(bucket));

  if (!entries || entries.length === 0) {
    console.log(`[Upcoming] No events at ${bucket}`);
    return { fired: 0 };
  }

  console.log(`[Upcoming] ${entries.length} event(s) at ${bucket}`);

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('[Upcoming] FCM token error:', err);
    return { fired: 0 };
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  let fired = 0;

  for (const entry of entries) {
    // Get channel meta
    const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(entry.channelId));
    const channelName = meta?.name || entry.channelId;

    // Get subscribers for this channel
    const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];

    for (const deviceId of subs) {
      const [profile, settings, override] = await Promise.all([
        getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, entry.channelId)),
      ]);

      if (!profile?.fcmToken) continue;

      const effective = {
        mode: override?.mode || settings?.mode || 'chill',
        nagInterval: override?.nagInterval || settings?.nagInterval || 15,
        dndEnabled: settings?.dndEnabled || false,
        dndStart: settings?.dndStart || '22:00',
        dndEnd: settings?.dndEnd || '07:00',
        dndBypass: override?.dndBypass || false,
        muted: override?.muted || false,
      };

      if (effective.muted) continue;

      const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd);
      if (dndActive && !effective.dndBypass) continue;

      let title, body;
      if (entry.headsUp) {
        title = `${channelName} going live soon`;
        body = 'Scheduled event starting in 30 minutes';
      } else {
        title = `${channelName} is live now!`;
        body = 'The scheduled event has started';
      }

      const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, {
        title,
        body,
        data: {
          videoId: entry.videoId,
          channelId: entry.channelId,
          channelName,
          type: entry.headsUp ? 'upcoming' : 'new_video',
        },
        tag: `video-${entry.videoId}`,
      });

      if (result.sent) {
        fired++;
      } else if (result.deadToken) {
        // Clean up dead device
        await env.TUBEPULSE_KV.delete(key.deviceProfile(deviceId));
        const currentSubs = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];
        await putKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId), currentSubs.filter((id) => id !== deviceId));
      }
    }

    // If this was the "live now" event (headsUp=false), also move video into nag system
    if (!entry.headsUp) {
      const subs2 = await getKV(env.TUBEPULSE_KV, key.channelSubs(entry.channelId)) || [];
      for (const deviceId of subs2) {
        const [settings2, override2] = await Promise.all([
          getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
          getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, entry.channelId)),
        ]);

        const mode = override2?.mode || settings2?.mode || 'chill';
        const nagInterval = override2?.nagInterval || settings2?.nagInterval || 15;
        const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, entry.channelId)) || {
          unwatched: [],
          lastNagAt: null,
          nagCount: 0,
        };

        // Ensure video is in unwatched
        if (!state.unwatched.includes(entry.videoId)) {
          state.unwatched.push(entry.videoId);
        }
        state.lastNagAt = Date.now();
        await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, entry.channelId), state);

        // Schedule next nag
        const nextNagTime = mode === 'chill'
          ? Date.now() + 4 * 60 * 60 * 1000
          : Date.now() + nagInterval * 60 * 1000;

        const nb = nagBucket(nextNagTime);
        const bucketData = await getKV(env.TUBEPULSE_KV, key.nag(nb)) || [];
        const exists = bucketData.some((e) => e.deviceId === deviceId && e.channelId === entry.channelId);
        if (!exists) {
          bucketData.push({
            deviceId,
            channelId: entry.channelId,
            videoIds: [...state.unwatched],
          });
          await putKV(env.TUBEPULSE_KV, key.nag(nb), bucketData);
        }
      }
    }
  }

  // Clear the processed bucket
  await env.TUBEPULSE_KV.delete(key.upcoming(bucket));

  return { fired };
}

// ─── Job 2: Nag cycle (every 15 min) ────────────────────────────────────

async function runNagCron(env) {
  const bucket = currentNagBucket();
  const entries = await getKV(env.TUBEPULSE_KV, key.nag(bucket));

  if (!entries || entries.length === 0) {
    console.log(`[Nag] No nags at ${bucket}`);
    return { fired: 0 };
  }

  console.log(`[Nag] ${entries.length} nag(s) at ${bucket}`);

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('[Nag] FCM token error:', err);
    return { fired: 0 };
  }

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  let fired = 0;
  const deadTokens = [];

  for (const entry of entries) {
    const { deviceId, channelId, videoIds: scheduledVideoIds } = entry;

    // Re-check state — videos may have been marked seen since bucket was written
    const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
    const stillUnwatched = scheduledVideoIds.filter(
      (id) => state?.unwatched?.includes(id)
    );

    if (stillUnwatched.length === 0) {
      continue; // All seen — skip
    }

    // Read device profile + settings + override
    const [profile, settings, override] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId)),
    ]);

    if (!profile?.fcmToken) continue;

    const effective = {
      mode: override?.mode || settings?.mode || 'chill',
      nagInterval: override?.nagInterval || settings?.nagInterval || 15,
      dndEnabled: settings?.dndEnabled || false,
      dndStart: settings?.dndStart || '22:00',
      dndEnd: settings?.dndEnd || '07:00',
      dndBypass: override?.dndBypass || false,
      muted: override?.muted || false,
      tapAction: settings?.tapAction || 'video',
    };

    if (effective.muted) continue;

    // DND check
    const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd);
    if (dndActive && !effective.dndBypass) {
      // Re-schedule nag for next bucket after DND ends
      // (approximation: just try again in 15 min)
      const nextBucket = nagBucket(Date.now() + 15 * 60 * 1000);
      const nextData = await getKV(env.TUBEPULSE_KV, key.nag(nextBucket)) || [];
      const exists = nextData.some((e) => e.deviceId === deviceId && e.channelId === channelId);
      if (!exists) {
        nextData.push({ deviceId, channelId, videoIds: stillUnwatched });
        await putKV(env.TUBEPULSE_KV, key.nag(nextBucket), nextData);
      }
      continue;
    }

    // Get channel info for notification text
    const [meta, recent] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)),
    ]);

    const channelName = meta?.name || channelId;

    // Build notification
    let notifPayload;
    if (stillUnwatched.length === 1) {
      const videoId = stillUnwatched[0];
      const video = recent?.find((v) => v.videoId === videoId);
      notifPayload = {
        title: `${channelName} — reminder`,
        body: video?.title || 'Unwatched video',
        data: {
          videoId,
          channelId,
          channelName,
          videoLink: video?.link || `https://www.youtube.com/watch?v=${videoId}`,
          type: 'nag',
        },
        tag: `video-${videoId}`,
      };
    } else {
      notifPayload = {
        title: `${channelName} — ${stillUnwatched.length} unwatched`,
        body: 'You have videos waiting',
        data: {
          type: 'batch',
          count: String(stillUnwatched.length),
          channelId,
        },
        tag: 'tubepulse-batch',
      };
    }

    const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);

    if (result.sent) {
      fired++;
      // Update state
      state.lastNagAt = Date.now();
      state.nagCount = (state.nagCount || 0) + 1;
      await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);

      // Schedule next nag
      const nagIntervalMs = effective.nagInterval * 60 * 1000;
      const nextNagTime = effective.mode === 'chill'
        ? Date.now() + 4 * 60 * 60 * 1000
        : Date.now() + nagIntervalMs;

      const nb = nagBucket(nextNagTime);
      const nextBucketData = await getKV(env.TUBEPULSE_KV, key.nag(nb)) || [];
      const exists = nextBucketData.some((e) => e.deviceId === deviceId && e.channelId === channelId);
      if (!exists) {
        nextBucketData.push({ deviceId, channelId, videoIds: stillUnwatched });
        await putKV(env.TUBEPULSE_KV, key.nag(nb), nextBucketData);
      }
    } else if (result.deadToken) {
      deadTokens.push(deviceId);
    }
  }

  // Clean up dead tokens
  for (const deviceId of deadTokens) {
    console.log(`[Nag] Pruning dead device: ${deviceId}`);
    await env.TUBEPULSE_KV.delete(key.deviceProfile(deviceId));
    // Remove from all subscriber lists — we don't know which channels,
    // but the next push to any channel they were on will skip them
    // A weekly consistency check should fully clean up
  }

  // Clear the processed bucket
  await env.TUBEPULSE_KV.delete(key.nag(bucket));

  return { fired };
}

// ─── Job 3: Lease renewal (every 6 hours) ──────────────────────────────

async function runLeaseCron(env) {
  const callbackUrl = 'https://tubepulse-api.aaronjoakley55.workers.dev/websub';
  const renewed = await renewSubscriptions(env, callbackUrl);
  return { renewed };
}

// ─── Main handler ───────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const startTime = Date.now();
    const now = new Date();
    const mins = now.getUTCMinutes();
    const hours = now.getUTCHours();

    console.log(`[Cron] Tick at ${now.toISOString()} (minute=${mins})`);

    const results = {};

    // Upcoming events: every 5 minutes (minute % 5 === 0)
    if (mins % 5 === 0) {
      results.upcoming = await runUpcomingCron(env);
    }

    // Nag cycle: every 15 minutes (minute % 15 === 0)
    if (mins % 15 === 0) {
      results.nag = await runNagCron(env);
    }

    // Lease renewal: every 6 hours (minute === 0 && hour % 6 === 0)
    if (mins === 0 && hours % 6 === 0) {
      results.lease = await runLeaseCron(env);
    }

    const elapsed = Date.now() - startTime;
    console.log(`[Cron] Done in ${elapsed}ms. Results:`, JSON.stringify(results));
  },
};