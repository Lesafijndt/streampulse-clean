import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaMetadataPatch, getMetadataLookupKey, isGenericMediaTitle, videoNeedsMetadataLookup } from '../src/mediaMetadata.js';
import { createDurationLookupOutcome, shouldRetryDurationLookup } from '../src/durationLookup.js';

const video = { id: 'yt-one', timestamp: 10, url: 'https://youtu.be/abcdefghijk', platform: 'youtube', title: 'YouTube Media (abcdefghijk)', durationSec: 123, duration: '02:03', durationSource: 'player', status: 'playing', upvotes: 17, playedAt: 20, requestedBy: 'viewer' };

test('placeholder title remains eligible when the player already supplied duration', () => {
  assert.equal(videoNeedsMetadataLookup(video), true);
  assert.equal(isGenericMediaTitle('TikTok Short Clip'), true);
  assert.equal(isGenericMediaTitle('YouTube Media (abcdefghijk)'), true);
  assert.equal(isGenericMediaTitle('Video incredible'), false);
  const patch = buildMediaMetadataPatch(video, video, { title: 'Actual creator title', durationSec: 125, thumbnailUrl: 'https://cdn.example/image.jpg', status: 'watched', upvotes: 0 });
  assert.deepEqual(patch, { title: 'Actual creator title', thumbnail: 'https://cdn.example/image.jpg' });
  const updated = { ...video, ...patch };
  assert.equal(videoNeedsMetadataLookup(updated), false);
  for (const key of ['status', 'upvotes', 'playedAt', 'requestedBy', 'durationSec']) assert.equal(updated[key], video[key]);
});

test('custom titles survive and empty or generic responses never replace a title', () => {
  for (const title of ['', 'YouTube Media', 'TikTok Short Clip']) assert.equal(buildMediaMetadataPatch(video, video, { title }).title, undefined);
  assert.equal(buildMediaMetadataPatch(video, { ...video, title: 'My custom title' }, { title: 'Provider title' }).title, undefined);
});

test('late response cannot patch replacement generation, URL, or deleted row', () => {
  for (const current of [null, { ...video, timestamp: 11 }, { ...video, playedAt: 21 }, { ...video, url: 'https://youtu.be/other' }]) {
    assert.deepEqual(buildMediaMetadataPatch(video, current, { title: 'Actual title', durationSec: 200 }), {});
  }
});

test('title retries have their own bounded backoff unaffected by found player duration', () => {
  const key = getMetadataLookupKey(video);
  assert.notEqual(key, video.id);
  assert.notEqual(key, getMetadataLookupKey({ ...video, timestamp: 11 }));
  const outcomes = { [video.id]: createDurationLookupOutcome({ status: 'found', at: 0 }) };
  assert.equal(shouldRetryDurationLookup(outcomes[key], 0), true);
  outcomes[key] = createDurationLookupOutcome({ status: 'unavailable', at: 1000 });
  assert.equal(shouldRetryDurationLookup(outcomes[key], 60_999), false);
  assert.equal(shouldRetryDurationLookup(outcomes[key], 61_000), true);
  const next = createDurationLookupOutcome({ status: 'error', previous: outcomes[key], at: 61_000 });
  assert.equal(next.nextRetryAt, 361_000);
});

test('real missing duration is filled alongside title without unrelated queue writes', () => {
  const missing = { ...video, duration: '', durationSec: undefined, durationSource: 'unknown' };
  assert.deepEqual(buildMediaMetadataPatch(missing, missing, { title: 'Actual title', durationSec: 89, durationProvider: 'youtube', generation: 'bad' }), {
    title: 'Actual title', durationSec: 89, duration: '1:29', durationSource: 'metadata', durationProvider: 'youtube'
  });
});
