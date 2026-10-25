import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTwitchClipPlayback, hasTwitchClipEnded } from '../src/twitchPlayback.js';

test('only valid retained VOD segments enable automatic completion', () => {
  assert.deepEqual(parseTwitchClipPlayback({ available: true, videoId: '123', offsetSeconds: 0, durationSeconds: 12.5 }), { videoId: '123', start: 0, duration: 12.5 });
  for (const source of [null, { available: false, videoId: '123', offsetSeconds: 0, durationSeconds: 10 }, { videoId: 'bad', offsetSeconds: 0, durationSeconds: 10 }, { videoId: '123', offsetSeconds: -1, durationSeconds: 10 }, { videoId: '123', offsetSeconds: 1, durationSeconds: 0 }]) assert.equal(parseTwitchClipPlayback(source), null);
});

test('completion uses real media position even after pause, buffering or blocked autoplay', () => {
  for (let poll = 0; poll < 10000; poll++) assert.equal(hasTwitchClipEnded(110, 100, 30), false);
  assert.equal(hasTwitchClipEnded(129.99, 100, 30), false);
  assert.equal(hasTwitchClipEnded(130, 100, 30), true);
  assert.equal(hasTwitchClipEnded(NaN, 100, 30), false);
});
