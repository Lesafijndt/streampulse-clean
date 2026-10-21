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
