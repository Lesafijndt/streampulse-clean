import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTSUB_STATUS_DRAIN_INTERVAL_MS,
  shouldScheduleEventSubDrain,
} from '../api/_lib/eventsub-drain-throttle.js';

test('first healthy status check may schedule inbox recovery', () => {
  assert.equal(shouldScheduleEventSubDrain(Date.now(), 0), true);
});

test('status polling does not schedule another retry drain before two minutes', () => {
  const last = 1_000_000;
  assert.equal(shouldScheduleEventSubDrain(last + EVENTSUB_STATUS_DRAIN_INTERVAL_MS - 1, last), false);
  assert.equal(shouldScheduleEventSubDrain(last + EVENTSUB_STATUS_DRAIN_INTERVAL_MS, last), true);
});

test('invalid timestamps do not cause an aggressive retry loop', () => {
  assert.equal(shouldScheduleEventSubDrain(0, 0), false);
  assert.equal(shouldScheduleEventSubDrain(1_000_000, Number.NaN), true);
});
