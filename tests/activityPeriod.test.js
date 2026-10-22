import test from 'node:test';
import assert from 'node:assert/strict';
import { filterActivityEventsByPeriod } from '../src/activityLog.js';

const now = 2_000_000_000_000;
const event = (id, at, sessionId = 'session-a', type = 'request_added') => ({
  id, type, at, sessionId, room: '2o3a', mediaId: id, title: id, requester: 'viewer', actor: '2o3a', platform: 'youtube', category: 'Music'
});

test('lifetime activity includes all valid sessions without duplicate IDs', () => {
  const result = filterActivityEventsByPeriod([event('old', now - 50 * 60 * 60 * 1000), event('new', now), event('new', now, 'session-b')], { period: 'lifetime', now });
  assert.deepEqual(result.map((item) => item.id), ['old', 'new']);
});

test('24-hour activity window excludes older and future-dated events', () => {
  const result = filterActivityEventsByPeriod([
    event('just-inside', now - 23 * 60 * 60 * 1000),
    event('at-boundary', now - 24 * 60 * 60 * 1000),
    event('too-old', now - 24 * 60 * 60 * 1000 - 1),
    event('future', now + 1)
  ], { period: '24h', now });
  assert.deepEqual(result.map((item) => item.id), ['at-boundary', 'just-inside']);
});

test('tab-session window includes only events tagged with the current session ID', () => {
  const result = filterActivityEventsByPeriod([event('same-tab', now, 'session-a'), event('other-tab', now, 'session-b')], { period: 'session', sessionId: 'session-a', now });
  assert.deepEqual(result.map((item) => item.id), ['same-tab']);
  assert.deepEqual(filterActivityEventsByPeriod([event('same-tab', now)], { period: 'session', sessionId: '', now }), []);
});
