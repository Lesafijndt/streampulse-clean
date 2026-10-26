import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShuffleQueueTransition } from '../src/queueShuffle.js';

test('shuffle conserves requests, keeps pinned slots and changes only waiting queueOrder', () => {
  const videos = [
    { id: 'c', status: 'queue', queueOrder: 3000, url: 'https://example.com/c', title: 'C', audioOnly: true },
    { id: 'a', status: 'queue', queueOrder: 1000, title: 'A' },
    { id: 'pin', status: 'queue', queueOrder: 2000, pinned: true, upvotes: 99 },
    { id: 'd', status: 'queue', queueOrder: 4000, title: 'D' },
    { id: 'playing', status: 'playing', queueOrder: 7, audioOnly: true },
    { id: 'history', status: 'watched', queueOrder: 8 },
    { id: 'later', status: 'watch_later', queueOrder: 9 }
  ];
  const original = structuredClone(videos);
  const { nextVideos, updates } = buildShuffleQueueTransition(videos, () => 0);
  assert.deepEqual(videos, original, 'input must not be mutated');
  assert.deepEqual(nextVideos.map((item) => item.id).sort(), videos.map((item) => item.id).sort());
  assert.deepEqual(nextVideos.filter((item) => item.status === 'queue').sort((a, b) => a.queueOrder - b.queueOrder).map((item) => item.id), ['c', 'pin', 'd', 'a']);
  assert.equal(nextVideos.find((item) => item.id === 'pin').queueOrder, 2000);
  assert.equal(updates.has('pin'), false);
  for (const item of nextVideos) {
    const prior = videos.find((video) => video.id === item.id);
    if (prior.status !== 'queue') assert.equal(item, prior);
    const { queueOrder, ...rest } = item;
    const { queueOrder: previousOrder, ...previousRest } = prior;
    assert.deepEqual(rest, previousRest);
  }
  for (const fields of updates.values()) assert.deepEqual(Object.keys(fields), ['queueOrder']);
});

test('identity shuffle produces no unnecessary writes for normalized ranks', () => {
  const videos = [{ id: 'a', status: 'queue', queueOrder: 1000 }, { id: 'b', status: 'queue', queueOrder: 2000 }];
  const result = buildShuffleQueueTransition(videos, () => 0.999);
  assert.equal(result.updates.size, 0);
  assert.deepEqual(result.nextVideos, videos);
  assert.equal(buildShuffleQueueTransition([]).updates.size, 0);
});

test('legacy timestamps establish initial pinned slots and normalize ranks', () => {
  const videos = [{ id: 'late', status: 'queue', timestamp: 30 }, { id: 'pin', status: 'queue', timestamp: 20, pinned: true }, { id: 'early', status: 'queue', timestamp: 10 }];
  const result = buildShuffleQueueTransition(videos, () => 0);
  assert.deepEqual(result.nextVideos.slice().sort((a, b) => a.queueOrder - b.queueOrder).map((item) => item.id), ['late', 'pin', 'early']);
  assert.deepEqual(result.updates.get('pin'), { queueOrder: 2000 });
});
