import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeMediaVideos,
  getMediaIdentityKey,
  getStableMediaDocumentId,
  getVideoCategory,
  getVideoMediaType,
  parseMediaUrl
} from '../src/mediaUtils.js';

test('YouTube URL variants resolve to the same canonical media identity', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(parseMediaUrl('https://www.youtube.com/watch?v=' + id).videoId, id);
  assert.equal(parseMediaUrl('https://youtu.be/' + id).videoId, id);
  assert.equal(getMediaIdentityKey('youtube', id, 'https://youtu.be/' + id), 'youtube:' + id.toLowerCase());
});

test('TikTok full video URLs expose the numeric video ID needed by the embed', () => {
  const parsed = parseMediaUrl('https://www.tiktok.com/@creator/video/1234567890123456789');
  assert.equal(parsed.platform, 'tiktok');
  assert.equal(parsed.videoId, '1234567890123456789');
});

test('stable media document IDs are deterministic for a given identity', () => {
  const identity = 'youtube:dQw4w9WgXcQ';
  assert.equal(getStableMediaDocumentId(identity), getStableMediaDocumentId(identity));
  assert.match(getStableMediaDocumentId(identity), /^media-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
});

test('a re-requested video in the queue wins over the same video in History, regardless of snapshot order', () => {
  const queued = { id: 'queued-copy', url: 'https://youtu.be/dQw4w9WgXcQ', platform: 'youtube', videoId: 'dQw4w9WgXcQ', status: 'queue', timestamp: 200 };
  const watched = { id: 'played-copy', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platform: 'youtube', videoId: 'dQw4w9WgXcQ', status: 'watched', timestamp: 100 };
  for (const input of [[queued, watched], [watched, queued]]) {
    const result = dedupeMediaVideos(input);
    assert.deepEqual(result.videos.map((video) => video.id), ['queued-copy']);
    assert.deepEqual(result.duplicateIds, ['played-copy']);
  }
});

test('the currently playing video takes precedence over an older queue or History copy', () => {
  const base = { url: 'https://youtu.be/dQw4w9WgXcQ', platform: 'youtube', videoId: 'dQw4w9WgXcQ' };
  const items = [
    { ...base, id: 'history', status: 'watched', timestamp: 100 },
    { ...base, id: 'waiting', status: 'queue', timestamp: 200 },
    { ...base, id: 'current', status: 'playing', timestamp: 150 },
  ];
  assert.deepEqual(dedupeMediaVideos(items).videos.map(x => x.id), ['current']);
});

test('manual category is authoritative and auto music detection remains consistent', () => {
  assert.equal(getVideoMediaType({ url: 'https://www.tiktok.com/@c/video/1234567890123', category: 'General', categoryManuallySet: true }), 'Non-Music');
  assert.equal(getVideoMediaType({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Unknown title' }), 'Music');
  assert.equal(getVideoCategory({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Unknown title', category: 'General' }), 'Music');
});
