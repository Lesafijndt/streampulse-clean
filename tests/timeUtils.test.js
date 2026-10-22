import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAbsoluteTimestamp, formatRelativeTimestamp } from '../src/timeUtils.js';

const now = Date.parse('2026-10-22T12:00:00Z');

test('relative timestamps reflect actual request and playback times', () => {
  assert.equal(formatRelativeTimestamp(now - 5000, now), 'just now');
  assert.equal(formatRelativeTimestamp(now - 4 * 60000, now), '4 minutes ago');
  assert.equal(formatRelativeTimestamp(now - 2 * 60 * 60000, now), '2 hours ago');
  assert.equal(formatRelativeTimestamp(now - 3 * 24 * 60 * 60000, now), '3 days ago');
  const oldTime = now - 21 * 24 * 60 * 60000;
  assert.equal(formatRelativeTimestamp(oldTime, now), new Date(oldTime).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }));
});

test('timestamp formatter supports ISO strings, epoch seconds, Date and missing legacy times', () => {
  assert.equal(formatRelativeTimestamp('2026-10-22T11:56:00Z', now), '4 minutes ago');
  assert.equal(formatRelativeTimestamp(Math.floor((now - 60000) / 1000), now), '1 minute ago');
  assert.equal(formatRelativeTimestamp(new Date(now - 60000), now), '1 minute ago');
  assert.equal(formatRelativeTimestamp('Just now', now), 'time unknown');
  assert.equal(formatRelativeTimestamp(null, now), 'time unknown');
  assert.notEqual(formatAbsoluteTimestamp(now - 60000), 'Original timestamp was not saved for this item');
  assert.equal(formatAbsoluteTimestamp(null), 'Original timestamp was not saved for this item');
});
