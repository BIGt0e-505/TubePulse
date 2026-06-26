const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(
  __dirname,
  '..',
  'worker',
  'tubepulse-cron',
  'fixtures',
  'community-posts'
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

(async () => {
  const {
    parseLatestCommunityPostFromInnerTubeResponse,
    fetchLatestCommunityPostInnerTube,
    parseInnerTubeRelativeAgeMs,
    estimatePublishedAtFromRelativeText,
    parseCommunityPostCountText,
    parseCommunityPostChannelAllowlist,
    isCommunityPostChannelAllowed,
    isCommunityPostEligible,
  } = await import('../worker/tubepulse-cron/community-posts.mjs');

  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({})],
    []
  );
  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: '  ',
    })],
    []
  );
  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: ' UCone , ,UCtwo, UCthree ',
    })],
    ['UCone', 'UCtwo', 'UCthree']
  );

  const allowlistEnv = {
    TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'yes',
    TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: 'UCeG5VyNPnGZq-8JzHJbSB6A,UCother',
  };
  assert.equal(
    isCommunityPostChannelAllowed('UCeG5VyNPnGZq-8JzHJbSB6A', allowlistEnv),
    true
  );
  assert.equal(isCommunityPostChannelAllowed('UCmissing', allowlistEnv), false);
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', allowlistEnv),
    true
  );
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: '0',
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: 'UCeG5VyNPnGZq-8JzHJbSB6A',
    }),
    false
  );
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true',
    }),
    false
  );
  assert.equal(isCommunityPostEligible('UCmissing', allowlistEnv), false);

  const parserNow = new Date('2026-06-26T12:00:00.000Z');
  assert.equal(parseInnerTubeRelativeAgeMs('just now'), 0);
  assert.equal(parseInnerTubeRelativeAgeMs('1 minute ago'), 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('42 minutes ago'), 42 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 hour ago'), 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 hours ago'), 4 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 day ago'), 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 days ago (edited)'), 4 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 week ago'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 weeks ago'), 4 * 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 month ago'), 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('6 months ago'), 6 * 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 year ago'), 365 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('2 years ago'), 2 * 365 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('not a relative time'), null);
  assert.equal(
    estimatePublishedAtFromRelativeText('42 minutes ago', parserNow),
    '2026-06-26T11:18:00.000Z'
  );
  assert.equal(parseCommunityPostCountText('1 like'), 1);
  assert.equal(parseCommunityPostCountText('42 likes'), 42);
  assert.equal(parseCommunityPostCountText('1.2K likes'), 1200);
  assert.equal(parseCommunityPostCountText('4,321 likes'), 4321);
  assert.equal(parseCommunityPostCountText('No likes'), null);

  const undertoe = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('undert0e505-latest.json'),
    { now: parserNow }
  );
  assert.equal(undertoe.id, 'post:UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(undertoe.activityId, 'UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(undertoe.postId, 'UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(
    undertoe.link,
    'https://www.youtube.com/post/UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v'
  );
  assert.equal(undertoe.kind, 'community');
  assert.equal(undertoe.source, 'innertube');
  assert.equal(undertoe.publishedAt, '2026-06-23T12:00:00.000Z');
  assert.equal(undertoe.publishedAtSource, 'estimated_from_relative');
  assert.equal(undertoe.publishedText, '3 days ago (edited)');
  assert.equal(undertoe.fetchedAt, '2026-06-26T12:00:00.000Z');
  assert.equal(undertoe.likeCount, 1);
  assert.equal(undertoe.likeText, '1 like');
  assert.equal(undertoe.viewCount, null);
  assert.equal(undertoe.viewText, null);
  assert.match(undertoe.text, /ZeroVPN v0\.1 is ready/);
  assert.equal(undertoe.thumbnail, 'https://yt3.ggpht.com/example=s800');

  const textOnly = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('youtube-text-only.json'),
    { now: parserNow }
  );
  assert.equal(textOnly.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');
  assert.equal(textOnly.thumbnail, null);
  assert.equal(textOnly.text, "let's run it back, beliebers.");
  assert.equal(textOnly.publishedAt, '2026-06-26T11:00:00.000Z');
  assert.equal(textOnly.publishedAtSource, 'estimated_from_relative');
  assert.equal(textOnly.publishedText, '1 hour ago');
  assert.equal(textOnly.likeCount, null);
  assert.equal(textOnly.likeText, null);
  assert.equal(textOnly.viewCount, null);
  assert.equal(textOnly.viewText, null);

  const missingOptional = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('missing-optional-fields.json'),
    { now: parserNow }
  );
  assert.equal(missingOptional.id, 'post:UgkxMissingOptionalFields');
  assert.equal(missingOptional.text, '');
  assert.equal(missingOptional.thumbnail, null);
  assert.equal(missingOptional.publishedAt, null);
  assert.equal(missingOptional.publishedAtSource, 'unknown');
  assert.equal(missingOptional.publishedText, null);
  assert.equal(missingOptional.likeCount, null);
  assert.equal(missingOptional.likeText, null);
  assert.equal(missingOptional.viewCount, null);
  assert.equal(missingOptional.viewText, null);

  const noPosts = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('no-posts.json')
  );
  assert.equal(noPosts, null);

  const fetched = await fetchLatestCommunityPostInnerTube('UCtestChannel', {
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(url, 'https://www.youtube.com/youtubei/v1/browse');
      assert.equal(request.method, 'POST');
      assert.equal(body.browseId, 'UCtestChannel');
      assert.equal(body.params, 'EgVwb3N0c_IGBAoCSgA%3D');
      assert.equal(body.context.client.clientName, 'WEB');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(loadFixture('youtube-text-only.json')),
      };
    },
    logger: { warn() {} },
    now: parserNow,
  });
  assert.equal(fetched.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');

  console.log('community post parser checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
