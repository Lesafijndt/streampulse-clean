import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityStatistics, createActivityEvent, mergeActivityEvents } from '../src/activityLog.js';

test('activity statistics count persistent requests across timestamps', () => {
  const older = createActivityEvent({ id: 'legacy-old', type: 'request_added', at: 1_600_000_000_000, video: { id: 'old-video', requestedBy: 'Alice', platform: 'youtube', category: 'Music' }, source: 'legacy_import' });
  const newer = createActivityEvent({ id: 'request-new', type: 'request_added', at: 1_800_000_000_000, video: { id: 'new-video', requestedBy: 'alice', platform: 'youtube', category: 'Music' } });
  const tiktok = createActivityEvent({ id: 'request-tiktok', type: 'request_added', at: 1_800_000_000_001, video: { id: 'tiktok-video', requestedBy: 'Bob', platform: 'tiktok', category: 'Memes' } });
  const stats = buildActivityStatistics([older, newer, tiktok, { ...newer, id: 'finished', type: 'playback_completed' }, { ...newer, id: 'skipped', type: 'track_skipped' }, { ...newer, id: 'vote', type: 'vote_cast' }, { ...newer, id: 'removed', type: 'request_removed' }]);
  assert.equal(stats.totalRequests, 3); assert.equal(stats.uniqueRequesters, 2);
  assert.equal(stats.completed, 1); assert.equal(stats.skipped, 1); assert.equal(stats.votes, 1); assert.equal(stats.removed, 1);
  assert.deepEqual(stats.platforms[0], { label: 'youtube', count: 2 });
  assert.deepEqual(stats.genres[0], { label: 'Music', count: 2 });
  assert.deepEqual(stats.requesters[0], { label: 'alice', count: 2 });
});

test('cloud and local activity events merge without duplicates', () => {
  const event = createActivityEvent({ id: 'same-event', type: 'request_added', at: 1_700_000_000_000, video: { id: 'video-1', title: 'Video', requestedBy: 'viewer', platform: 'youtube' } });
  assert.equal(mergeActivityEvents([event], [{ ...event }]).length, 1);
  assert.equal(mergeActivityEvents([event], [{ ...event, id: 'invalid', type: 'unknown' }]).length, 1);
});

test('activity event payloads reject unsupported types and do not store source URLs', () => {
  assert.equal(createActivityEvent({ type: 'arbitrary', video: { url: 'https://example.invalid' } }), null);
  const event = createActivityEvent({ id: 'bounded', type: 'request_added', at: 1_700_000_000_000, video: { id: '1', title: ' A title ', url: 'https://example.invalid', requestedBy: '@TestUser', platform: 'youtube', category: 'Music' } });
  assert.equal(event.requester, 'testuser'); assert.equal(event.title, 'A title'); assert.equal('url' in event, false);
});

test('activity statistics retain the top ten requesters for the Stats board', () => {
  const events = Array.from({ length: 12 }, (_, index) => createActivityEvent({
    id: 'requester-' + index,
    type: 'request_added',
    at: 1_800_000_000_000 + index,
    video: { id: 'video-' + index, requestedBy: 'viewer' + index, platform: 'youtube' }
  }));
  const stats = buildActivityStatistics(events);
  assert.equal(stats.requesters.length, 10);
  assert.equal(stats.requesters[0].label, 'viewer0');
  assert.equal(stats.requesters[9].label, 'viewer9');
});
