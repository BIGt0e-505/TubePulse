import {
  seedKnownVideosFromRss,
  classifyRssVideosForNotification,
  updateKnownVideosAfterPoll,
  boundKnownVideoIds,
  jsonEqual,
} from '../worker/tubepulse-cron/shared.mjs';

function makeVideo(id, publishedAt, overrides = {}) {
  return {
    videoId: id,
    title: `title-${id}`,
    published: publishedAt,
    thumbnail: `thumb-${id}`,
    link: `https://youtube.com/watch?v=${id}`,
    views: '1000',
    likes: '10',
    dislikes: '0',
    ...overrides,
  };
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assertOk(cond, msg) {
  if (!cond) throw new Error(msg);
}

const nowIso = new Date('2026-07-23T04:00:00.000Z').toISOString();
const t1 = '2026-07-23T03:00:00.000Z';
const t2 = '2026-07-23T03:30:00.000Z';
const t3 = '2026-07-23T03:45:00.000Z';

console.log('TEST: stable poll repeated 10 times after seed');
{
  const rss = [
    makeVideo('v3', t3),
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  let known = seedKnownVideosFromRss(null, rss, nowIso).nextKnown;
  assertOk(known.highWatermarkAt === t3, 'seed watermark should be latest');

  let knownWrites = 0;
  for (let i = 0; i < 10; i++) {
    const result = updateKnownVideosAfterPoll(known, rss, [], nowIso);
    if (result.changed) knownWrites++;
    known = result.nextKnown;
  }
  assertEqual(knownWrites, 0, 'subsequent stable polls should not change known state');
  console.log('  PASS: 0 known writes across 10 stable polls');
}

console.log('TEST: deletion exposes older videos, then stable again');
{
  const rssFull = [
    makeVideo('v3', t3),
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  const rssAfterDelete = [
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  let known = seedKnownVideosFromRss(null, rssFull, nowIso).nextKnown;

  const firstResult = updateKnownVideosAfterPoll(known, rssAfterDelete, [], nowIso);
  let knownWrites = firstResult.changed ? 1 : 0;
  known = firstResult.nextKnown;

  for (let i = 0; i < 10; i++) {
    const result = updateKnownVideosAfterPoll(known, rssAfterDelete, [], nowIso);
    if (result.changed) knownWrites++;
    known = result.nextKnown;
  }
  assertEqual(knownWrites, 1, 'only one known write for deletion exposure, then stable');
  console.log('  PASS: 1 known write on deletion exposure, 0 thereafter');
}

console.log('TEST: new upload advances watermark once, then stable');
{
  const rssOld = [
    makeVideo('v3', t3),
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  const t4 = '2026-07-23T04:10:00.000Z';
  const rssNew = [
    makeVideo('v4', t4),
    makeVideo('v3', t3),
    makeVideo('v2', t2),
  ];
  let known = seedKnownVideosFromRss(null, rssOld, nowIso).nextKnown;

  const classified = classifyRssVideosForNotification(known, rssNew);
  const newVideos = classified.filter((v) => v.isNew);
  assertEqual(newVideos.length, 1, 'one new video above watermark');

  const firstResult = updateKnownVideosAfterPoll(known, rssNew, newVideos, nowIso);
  let knownWrites = firstResult.changed ? 1 : 0;
  known = firstResult.nextKnown;

  for (let i = 0; i < 10; i++) {
    const result = updateKnownVideosAfterPoll(known, rssNew, [], nowIso);
    if (result.changed) knownWrites++;
    known = result.nextKnown;
  }
  assertEqual(knownWrites, 1, 'only one known write for new upload, then stable');
  assertOk(known.highWatermarkAt === t4, 'watermark should advance to new video');
  console.log('  PASS: 1 known write on new upload, 0 thereafter');
}

console.log('TEST: metadata-only unchanged should not touch known state');
{
  const rss = [
    makeVideo('v3', t3, { title: 'Original title', views: '1000' }),
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  const rssMetaChanged = [
    makeVideo('v3', t3, { title: 'Original title', views: '5000' }),
    makeVideo('v2', t2),
    makeVideo('v1', t1),
  ];
  let known = seedKnownVideosFromRss(null, rss, nowIso).nextKnown;

  const result = updateKnownVideosAfterPoll(known, rssMetaChanged, [], nowIso);
  assertEqual(result.changed, false, 'metadata change alone must not mark known changed');
  console.log('  PASS: metadata change does not rewrite known:videos');
}

console.log('TEST: boundKnownVideoIds must not create false change for identical list');
{
  const ids = ['a', 'b', 'c'];
  const bound1 = boundKnownVideoIds(ids);
  const bound2 = boundKnownVideoIds(ids);
  assertOk(jsonEqual(bound1, bound2), 'bounded identical lists should be json-equal');
  console.log('  PASS: bounded list comparison is stable');
}

console.log('ALL SIMULATION TESTS PASSED');
