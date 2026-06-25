const INNERTUBE_BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse';
const POSTS_TAB_PARAMS = 'EgVwb3N0c_IGBAoCSgA%3D';
const DEFAULT_CLIENT_NAME = 'WEB';
const DEFAULT_CLIENT_VERSION = '2.20240101';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_REGION = 'GB';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function textFromRuns(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run?.text || '').join('');
  }
  return '';
}

function findBackstagePostThreads(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findBackstagePostThreads(item, out);
    return out;
  }
  if (node.backstagePostThreadRenderer) {
    out.push(node.backstagePostThreadRenderer);
  }
  for (const value of Object.values(node)) {
    findBackstagePostThreads(value, out);
  }
  return out;
}

function collectThumbnailUrls(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectThumbnailUrls(item, out);
    return out;
  }
  if (Array.isArray(node.thumbnails)) {
    for (const thumb of node.thumbnails) {
      if (typeof thumb?.url === 'string' && thumb.url) {
        out.push({
          url: thumb.url,
          width: Number(thumb.width) || 0,
          height: Number(thumb.height) || 0,
        });
      }
    }
  }
  for (const value of Object.values(node)) {
    collectThumbnailUrls(value, out);
  }
  return out;
}

function bestThumbnailUrl(attachment) {
  const thumbnails = collectThumbnailUrls(attachment);
  if (thumbnails.length === 0) return null;
  thumbnails.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return thumbnails[0].url;
}

function normalizeBackstagePostRenderer(post) {
  if (!post || typeof post !== 'object') return null;
  const postId = post.postId;
  if (!postId || typeof postId !== 'string') return null;

  return {
    id: `post:${postId}`,
    activityId: postId,
    postId,
    publishedAt: null,
    publishedText: textFromRuns(post.publishedTimeText) || null,
    text: textFromRuns(post.contentText),
    thumbnail: bestThumbnailUrl(post.backstageAttachment),
    kind: 'community',
    link: `https://www.youtube.com/post/${postId}`,
    source: 'innertube',
  };
}

export function parseLatestCommunityPostFromInnerTubeResponse(data) {
  const threads = findBackstagePostThreads(data);
  for (const thread of threads) {
    const normalized = normalizeBackstagePostRenderer(
      thread?.post?.backstagePostRenderer
    );
    if (normalized) return normalized;
  }
  return null;
}

export async function fetchLatestCommunityPostInnerTube(channelId, options = {}) {
  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const logger = options.logger || console;
  const language = options.language || DEFAULT_LANGUAGE;
  const region = options.region || DEFAULT_REGION;
  const clientName = options.clientName || DEFAULT_CLIENT_NAME;
  const clientVersion = options.clientVersion || DEFAULT_CLIENT_VERSION;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(INNERTUBE_BROWSE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName,
            clientVersion,
            hl: language,
            gl: region,
          },
        },
        browseId: channelId,
        params: POSTS_TAB_PARAMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`InnerTube browse failed: HTTP ${response.status}`);
    }

    const text = await response.text();
    if (text.length > maxResponseBytes) {
      throw new Error(`InnerTube response too large: ${text.length} bytes`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      logger?.warn?.(`[Posts] InnerTube returned invalid JSON for ${channelId}`);
      return null;
    }

    return parseLatestCommunityPostFromInnerTubeResponse(data);
  } finally {
    clearTimeout(timer);
  }
}
