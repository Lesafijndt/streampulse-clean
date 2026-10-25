import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCategoryCounts,
  buildNextTrackTransition,
  buildPreviousTrackTransition,
  buildQueueSyncWrites,
  filterVideosForView,
  formatMediaDuration,
  getDurationLabel,
  getQueueMediaCounts
} from '../src/queueLogic.js';

const compareQueueOrder = (a, b) => Number(a.queueOrder || 0) - Number(b.queueOrder || 0);
const getCategory = (video) => video.category || 'General';
const getMediaType = (video) => video.mediaType || 'Non-Music';

test('Previous followed by Next returns to the exact video that was playing', () => {
  const videos = [
    { id: 'a', status: 'watched', playedAt: 100, timestamp: 100, queueOrder: 1 },
    { id: 'b', status: 'playing', playedAt: 200, timestamp: 200, queueOrder: 2 },
    { id: 'c', status: 'queue', playedAt: 0, timestamp: 300, queueOrder: 3 }
  ];
  const previous = buildPreviousTrackTransition(videos, videos[1], 400);
  assert.equal(previous.previouslyPlayed.id, 'a');
  assert.equal(previous.nextVideos.find((video) => video.id === 'a').status, 'playing');
  assert.equal(previous.nextVideos.find((video) => video.id === 'b').status, 'queue');
  const next = buildNextTrackTransition(previous.nextVideos, previous.nextVideos.find((video) => video.status === 'playing'), compareQueueOrder, 500);
  assert.equal(next.nextOne.id, 'b');
  assert.equal(next.nextVideos.find((video) => video.id === 'b').status, 'playing');
  assert.equal(next.nextVideos.find((video) => video.id === 'a').status, 'watched');
});

test('Previous replays the latest history item when the active queue is empty', () => {
  const history = [{ id: 'older', status: 'watched', playedAt: 100 }, { id: 'latest', status: 'watched', playedAt: 200 }];
  const transition = buildPreviousTrackTransition(history, null, 300);
  assert.equal(transition.previouslyPlayed.id, 'latest');
  assert.equal(transition.updates.size, 1);
  assert.equal(transition.nextVideos.find(item => item.id === 'latest').status, 'playing');
  assert.equal(transition.nextVideos.find(item => item.id === 'latest').nextTrackOverrideId, null);
  assert.equal(transition.nextVideos.find(item => item.id === 'older').status, 'watched');
  assert.equal(buildPreviousTrackTransition([], null).previouslyPlayed, null);
});

test('Next honors the Previous return target ahead of regular queue order', () => {
  const videos = [
    { id: 'previous', status: 'playing', nextTrackOverrideId: 'return', queueOrder: 50 },
    { id: 'first', status: 'queue', queueOrder: 1 },
    { id: 'return', status: 'queue', queueOrder: 99 }
  ];
  const transition = buildNextTrackTransition(videos, videos[0], compareQueueOrder, 1000);
  assert.equal(transition.nextOne.id, 'return');
});

test('Next with an empty queue marks the playing video watched and picks no next item', () => {
  const videos = [{ id: 'only', status: 'playing', queueOrder: 1 }];
  const transition = buildNextTrackTransition(videos, videos[0], compareQueueOrder, 1000);
  assert.equal(transition.nextOne, null);
  assert.equal(transition.nextVideos[0].status, 'watched');
});

test('Non-Music filter renders 26 while preserving the Music category count of 5', () => {
  const videos = [];
  for (let i = 0; i < 5; i += 1) {
    videos.push({ id: 'music-' + i, status: 'queue', mediaType: 'Music', category: 'Music', queueOrder: i });
  }
  for (let i = 0; i < 26; i += 1) {
    videos.push({ id: 'other-' + i, status: 'queue', mediaType: 'Non-Music', category: i % 2 ? 'Gaming' : 'General', queueOrder: 5 + i });
  }
  const filtered = filterVideosForView(videos, {
    activeTab: 'queue', selectedCategory: 'All', mediaTypeFilter: 'Non-Music', searchQuery: '', sortBy: 'priority'
  }, { getVideoCategory: getCategory, getVideoMediaType: getMediaType, compareQueueOrder });
  const counts = buildCategoryCounts(videos, 'queue', 'Non-Music', getCategory, getMediaType);
  const mediaCounts = getQueueMediaCounts(videos, getMediaType);
  assert.equal(filtered.length, 26);
  assert.equal(counts.All, 26);
  assert.equal(counts.Music, 5);
  assert.equal(mediaCounts.music, 5);
  assert.equal(mediaCounts.nonMusic, 26);
});

test('Category and search filters work together with queue ordering', () => {
  const videos = [
    { id: 'late', status: 'queue', mediaType: 'Non-Music', category: 'Gaming', title: 'Valorant guide', queueOrder: 20 },
    { id: 'early', status: 'queue', mediaType: 'Non-Music', category: 'Gaming', title: 'Valorant highlights', queueOrder: 10 },
    { id: 'music', status: 'queue', mediaType: 'Music', category: 'Music', title: 'Valorant song', queueOrder: 1 }
  ];
  const filtered = filterVideosForView(videos, {
    activeTab: 'queue', selectedCategory: 'Gaming', mediaTypeFilter: 'Non-Music', searchQuery: 'valorant', sortBy: 'priority'
  }, { getVideoCategory: getCategory, getVideoMediaType: getMediaType, compareQueueOrder });
  assert.deepEqual(filtered.map((video) => video.id), ['early', 'late']);
});

test('Queue transition sync writes preserve every transitioned item and room', () => {
  const videos = [
    { id: 'a', title: 'Currently playing', status: 'playing', queueOrder: 1 },
    { id: 'b', title: 'Next item', status: 'queue', queueOrder: 2 }
  ];
  const transition = buildNextTrackTransition(videos, videos[0], compareQueueOrder, 1234);
  const writes = buildQueueSyncWrites(transition.updatesById, videos, '2o3a');
  assert.deepEqual(writes.map((write) => write.id), ['a', 'b']);
  assert.equal(writes[0].payload.status, 'watched');
  assert.equal(writes[0].payload.channelRoom, '2o3a');
  assert.equal(writes[1].payload.status, 'playing');
  assert.equal(writes[1].payload.title, 'Next item');
});

test('Actual media durations are formatted; placeholder estimates are not displayed as facts', () => {
  assert.equal(formatMediaDuration(45), '0:45');
  assert.equal(formatMediaDuration(225), '3:45');
  assert.equal(formatMediaDuration(3723), '1:02:03');
  assert.equal(formatMediaDuration(0), '');
  assert.equal(getDurationLabel({ platform: 'youtube', duration: '03:45', durationSec: 225 }), '—');
  assert.equal(getDurationLabel({ platform: 'tiktok', duration: '00:45', durationSec: 45 }), '—');
  assert.equal(getDurationLabel({ platform: 'youtube', duration: '3:45', durationSec: 225, durationSource: 'metadata' }), '3:45');
  assert.equal(getDurationLabel({ platform: 'youtube', duration: '', durationSource: 'unknown' }), '—');
});


test('Queue ETAs use provider durations and flag missing durations as fallback estimates', async () => {
  const { getDurationEstimate, estimateVideoDurationSeconds } = await import('../src/queueLogic.js');
  assert.deepEqual(getDurationEstimate({
    platform: 'tiktok', duration: '2:20', durationSec: 140, durationSource: 'metadata'
  }), { seconds: 140, estimated: false, source: 'metadata' });
  assert.deepEqual(getDurationEstimate({
    platform: 'youtube', duration: '', durationSource: 'unknown', url: 'https://www.youtube.com/shorts/abc'
  }), { seconds: 60, estimated: true, source: 'fallback' });
  assert.equal(estimateVideoDurationSeconds({
    platform: 'youtube', duration: '4:12', durationSec: 252, durationSource: 'metadata'
  }), 252);
  assert.deepEqual(getDurationEstimate({
    platform: 'tiktok', duration: '00:45', durationSec: 45, durationSource: 'unknown'
  }), { seconds: 45, estimated: true, source: 'fallback' });
});

test('Queue backup can be created and validated without losing queue or settings', async () => {
  const { createQueueBackup, validateQueueBackup } = await import('../src/queueLogic.js');
  const created = createQueueBackup({
    channelRoom: '2o3a',
    savedAt: 1234,
    videos: [{ id: 'one', title: 'Test clip', url: 'https://www.youtube.com/watch?v=abcdefghijk', status: 'queue' }],
    streamSettings: { queueOpen: false, autoPlayNext: true },
    votedIds: { 'viewer:one': true }
  });
  const checked = validateQueueBackup(created);
  assert.equal(checked.valid, true);
  assert.equal(checked.backup.channelRoom, '2o3a');
  assert.equal(checked.backup.videos.length, 1);
  assert.equal(checked.backup.streamSettings.queueOpen, false);
  assert.equal(checked.backup.votedIds['viewer:one'], true);
});

test('Queue backup validation rejects unsafe URLs, duplicate IDs, and unrelated JSON', async () => {
  const { validateQueueBackup } = await import('../src/queueLogic.js');
  assert.equal(validateQueueBackup({}).valid, false);
  const base = {
    format: 'whale-cum-backup', version: 1, channelRoom: '2o3a', savedAt: 1,
    videos: [{ id: 'one', title: 'Bad URL', url: 'javascript:alert(1)', status: 'queue' }],
    streamSettings: {}, votedIds: {}
  };
  assert.equal(validateQueueBackup(base).valid, false);
  const duplicate = { ...base, videos: [
    { id: 'same', title: 'One', url: 'https://youtu.be/abcdefghijk', status: 'queue' },
    { id: 'same', title: 'Two', url: 'https://youtu.be/12345678901', status: 'watched' }
  ] };
  assert.equal(validateQueueBackup(duplicate).valid, false);
});


test('Queue statistics report retained requesters, platforms, genres, runtime, and history', async () => {
  const { buildQueueStatistics } = await import('../src/queueLogic.js');
  const now = 10_000_000_000;
  const data = [
    { id: '1', status: 'queue', requestedBy: 'Alice', platform: 'youtube', category: 'Music', timestamp: now - 1000, durationSec: 180, durationSource: 'metadata' },
    { id: '2', status: 'queue', requestedBy: 'alice', platform: 'youtube', category: 'Music', timestamp: now - 2000, durationSec: 120, durationSource: 'metadata' },
    { id: '3', status: 'watched', requestedBy: 'Bob', platform: 'tiktok', category: 'Memes', timestamp: now - 4 * 60 * 60 * 1000, playedAt: now - 20 * 60 * 1000 },
    { id: '4', status: 'watched', requestedBy: 'Carol', platform: 'twitch', category: 'Gaming', timestamp: now - 60_000, playedAt: now - 2 * 60 * 60 * 1000 },
    { id: '5', status: 'queue', requestedBy: 'Dave', platform: 'tiktok', category: 'Memes', timestamp: now - 30 * 60 * 1000, durationSource: 'unknown' }
  ];
  const stats = buildQueueStatistics(data);
  assert.equal(stats.totalRequests, 5);
  assert.equal(stats.totalRequesters, 4);
  assert.equal(stats.queueCount, 3);
  assert.equal(stats.queueDurationSeconds, 180 + 120 + 45);
  assert.equal(stats.historyCount, 2);
  assert.deepEqual(stats.mostPopularPlatform, { label: 'tiktok', count: 2 });
  assert.deepEqual(stats.mostPopularGenre, { label: 'Memes', count: 2 });
  assert.deepEqual(stats.mostActiveRequester, { label: 'alice', count: 2 });
});

test('player-reported real 03:45 duration is not hidden as a legacy placeholder', () => {
  assert.equal(getDurationLabel({ platform: 'youtube', duration: '03:45', durationSec: 225, durationSource: 'player' }), '3:45');
});


test('known local duration survives an older Firestore snapshot without replacing newer queue state', async () => {
  const { mergeVideoDurationData, getDurationEstimate, formatRuntimeHoursMinutes } = await import('../src/queueLogic.js');
  const cloud = [{ id: 'video-1', title: 'Example', status: 'queue', duration: '', durationSource: 'unknown', upvotes: 4 }];
  const local = [{ id: 'video-1', title: 'Example', status: 'playing', duration: '03:45', durationSec: 225, durationSource: 'player', upvotes: 5 }];
  const merged = mergeVideoDurationData(cloud, local);
  assert.equal(merged[0].status, 'queue', 'only the duration fields should be merged');
  assert.equal(merged[0].upvotes, 4);
  assert.equal(merged[0].duration, '3:45');
  assert.equal(merged[0].durationSec, 225);
  assert.equal(merged[0].durationSource, 'player');
  assert.deepEqual(getDurationEstimate(merged[0]), { seconds: 225, estimated: false, source: 'player' });
  assert.equal(formatRuntimeHoursMinutes(3600 + 61), '1h 2m');
  assert.equal(formatRuntimeHoursMinutes(0), '0h 0m');
});

test('trusted player-reported default-looking lengths are never demoted to fallbacks', async () => {
  const { getDurationEstimate, getDurationLabel } = await import('../src/queueLogic.js');
  assert.deepEqual(getDurationEstimate({ platform: 'youtube', duration: '3:45', durationSec: 225, durationSource: 'player' }), { seconds: 225, estimated: false, source: 'player' });
  assert.equal(getDurationLabel({ platform: 'youtube', duration: '03:45', durationSec: 225, durationSource: 'player' }), '3:45');
});

test('Thumbnail duration always shows a real or clearly approximate value', async () => {
  const { getThumbnailDurationLabel } = await import('../src/queueLogic.js');
  assert.equal(getThumbnailDurationLabel({ platform: 'youtube', durationSec: 247, durationSource: 'metadata' }), '4:07');
  assert.equal(getThumbnailDurationLabel({ platform: 'youtube', url: 'https://www.youtube.com/watch?v=abcdef' }), '~3:00');
  assert.equal(getThumbnailDurationLabel({ platform: 'youtube', url: 'https://www.youtube.com/shorts/abcdef', isVertical: true }), '~1:00');
  assert.equal(getThumbnailDurationLabel({ platform: 'tiktok', url: 'https://www.tiktok.com/@viewer/video/123456' }), '~0:45');
});

test('Duration cache keys are stable and cached actual duration hydrates older queue rows', async () => {
  const { getDurationCacheKey, applyCachedVideoDurations } = await import('../src/queueLogic.js');
  const first = { platform: 'youtube', videoId: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk?si=foo' };
  const second = { platform: 'youtube', videoId: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk?feature=shared' };
  assert.equal(getDurationCacheKey(first), getDurationCacheKey(second));
  const hydrated = applyCachedVideoDurations([{ id: '1', ...first, duration: '', durationSource: 'unknown' }], {
    'youtube:abcdefghijk': { seconds: 247, source: 'metadata', updatedAt: 1 }
  });
  assert.equal(hydrated[0].duration, '4:07');
  assert.equal(hydrated[0].durationSec, 247);
  assert.equal(hydrated[0].durationSource, 'metadata');
});

test('Queue runway stats separate known runtime from estimates', async () => {
  const { buildQueueStatistics } = await import('../src/queueLogic.js');
  const stats = buildQueueStatistics([
    { id: 'known', status: 'queue', platform: 'youtube', durationSec: 240, durationSource: 'metadata' },
    { id: 'unknown', status: 'queue', platform: 'tiktok', duration: '', durationSource: 'unknown' }
  ], 10_000_000_000);
  assert.equal(stats.queueKnownCount, 1);
  assert.equal(stats.queueEstimatedCount, 1);
  assert.equal(stats.queueKnownDurationSeconds, 240);
  assert.equal(stats.queueEstimatedDurationSeconds, 45);
  assert.equal(stats.queueDurationSeconds, 285);
});

test('Stats platform, genre and requester rankings use all retained items', async () => {
  const { buildQueueStatistics } = await import('../src/queueLogic.js');
  const now = 50_000_000_000;
  const stats = buildQueueStatistics([
    { id: 'recent-1', status: 'queue', requestedBy: 'alice', platform: 'youtube', category: 'Music', timestamp: now - 1000 },
    { id: 'recent-2', status: 'watched', requestedBy: 'ALICE', platform: 'youtube', category: 'Music', timestamp: now - 2000 },
    { id: 'recent-3', status: 'queue', requestedBy: 'bob', platform: 'tiktok', category: 'Memes', timestamp: now - 3000 },
    { id: 'old-1', status: 'watched', requestedBy: 'carol', platform: 'tiktok', category: 'Memes', timestamp: now - 4 * 60 * 60 * 1000 }
  ]);
  assert.equal(stats.totalRequests, 4);
  assert.deepEqual(stats.mostPopularPlatform, { label: 'tiktok', count: 2 });
  assert.deepEqual(stats.mostPopularGenre, { label: 'Memes', count: 2 });
  assert.deepEqual(stats.mostActiveRequester, { label: 'alice', count: 2 });
  assert.equal(stats.totalRequesters, 3, 'overall unique counts are only for retained items');
});


test('duration retry policy backs off after failures and retries legacy failed records', async () => {
  const { createDurationLookupOutcome, getDurationRetryDelayMs, shouldRetryDurationLookup } = await import('../src/durationLookup.js');
  const first = createDurationLookupOutcome({ status: 'unavailable', platform: 'tiktok', at: 1000, reason: 'blocked' });
  assert.equal(first.attempts, 1);
  assert.equal(first.nextRetryAt, 1000 + 60_000);
  assert.equal(shouldRetryDurationLookup(first, first.nextRetryAt - 1), false);
  assert.equal(shouldRetryDurationLookup(first, first.nextRetryAt), true);
  assert.equal(shouldRetryDurationLookup('unavailable', 1000), true);
  assert.equal(shouldRetryDurationLookup(first, 1001, true), true);
  const second = createDurationLookupOutcome({ status: 'error', platform: 'youtube', previous: first, at: 2000 });
  assert.equal(second.attempts, 2);
  assert.equal(second.nextRetryAt, 2000 + getDurationRetryDelayMs(2));
});

test('duration enrichment retries missing YouTube/TikTok durations but skips valid or unrelated items', async () => {
  const { videoNeedsDurationLookup } = await import('../src/durationLookup.js');
  assert.equal(videoNeedsDurationLookup({ id: 'tt', url: 'https://www.tiktok.com/@u/video/1234567890123', platform: 'tiktok' }), true);
  assert.equal(videoNeedsDurationLookup({ id: 'yt', url: 'https://youtu.be/dQw4w9WgXcQ', platform: 'youtube', duration: '3:01', durationSec: 181, durationSource: 'metadata' }), false);
  assert.equal(videoNeedsDurationLookup({ id: 'web', url: 'https://example.com/v', platform: 'web' }), false);
});


test('track transition persists the real playback timestamp instead of a static relative label', () => {
  const videos = [
    { id: 'outgoing', status: 'playing', timestamp: 100, queueOrder: 1 },
    { id: 'next', status: 'queue', timestamp: 200, queueOrder: 2 }
  ];
  const transitionAt = Date.parse('2026-10-22T12:00:00Z');
  const transition = buildNextTrackTransition(videos, videos[0], compareQueueOrder, transitionAt);
  const outgoing = transition.nextVideos.find((video) => video.id === 'outgoing');
  assert.equal(outgoing.playedAt, transitionAt);
  assert.equal(outgoing.watchedAt, new Date(transitionAt).toISOString());
  assert.notEqual(outgoing.watchedAt, 'Just now');
});
