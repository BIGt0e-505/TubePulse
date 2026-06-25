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
  } = await import('../worker/tubepulse-cron/community-posts.mjs');

  const undertoe = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('undert0e505-latest.json')
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
  assert.equal(undertoe.publishedAt, null);
  assert.equal(undertoe.publishedText, '3 days ago (edited)');
  assert.match(undertoe.text, /ZeroVPN v0\.1 is ready/);
  assert.equal(undertoe.thumbnail, 'https://yt3.ggpht.com/example=s800');

  const textOnly = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('youtube-text-only.json')
  );
  assert.equal(textOnly.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');
  assert.equal(textOnly.thumbnail, null);
  assert.equal(textOnly.text, "let's run it back, beliebers.");
  assert.equal(textOnly.publishedText, '1 hour ago');

  const missingOptional = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('missing-optional-fields.json')
  );
  assert.equal(missingOptional.id, 'post:UgkxMissingOptionalFields');
  assert.equal(missingOptional.text, '');
  assert.equal(missingOptional.thumbnail, null);
  assert.equal(missingOptional.publishedText, null);

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
  });
  assert.equal(fetched.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');

  console.log('community post parser checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
