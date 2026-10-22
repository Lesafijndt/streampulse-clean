import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePendingQueueAdds, shouldSuppressLocalOnlySyncToast } from '../src/queueSync.js';

test('obsolete browser-only sync notification is suppressed without hiding ordinary notices', () => {
  assert.equal(shouldSuppressLocalOnlySyncToast(
    'Your request was saved in the dashboard browser, but cloud sync failed. The streamer may not see it until sync recovers.'
  ), true);
  assert.equal(shouldSuppressLocalOnlySyncToast('Your request was added to the queue.'), false);
});

test('pending local requests survive an empty or stale cloud snapshot', () => {
  const pending = [{ id: 'local-a', title: 'New chat request' }];
  assert.deepEqual(mergePendingQueueAdds([], pending), pending);
});

test('queue snapshot merges pending requests without duplicating cloud-confirmed IDs', () => {
  const cloud = [{ id: 'cloud-a', title: 'Already synced' }, { id: 'local-a', title: 'Cloud version' }];
  const pending = [
    { id: 'local-a', title: 'Optimistic local version' },
    { id: 'local-b', title: 'Not synced yet' },
  ];
  assert.deepEqual(mergePendingQueueAdds(cloud, pending), [
    { id: 'cloud-a', title: 'Already synced' },
    { id: 'local-a', title: 'Cloud version' },
    { id: 'local-b', title: 'Not synced yet' },
  ]);
});

test('only explicitly pending local requests are preserved after a cloud-side delete', () => {
  const cloud = [{ id: 'still-here', title: 'Still here' }];
  const pending = [{ id: 'new-local', title: 'New local add' }];
  assert.deepEqual(mergePendingQueueAdds(cloud, pending), [
    { id: 'still-here', title: 'Still here' },
    { id: 'new-local', title: 'New local add' },
  ]);
  assert.deepEqual(mergePendingQueueAdds(cloud, []), cloud);
});

test('pending request IDs are normalized to strings for duplicate checks', () => {
  assert.deepEqual(mergePendingQueueAdds([{ id: 123, title: 'Confirmed' }], [{ id: '123', title: 'Pending' }]), [
    { id: 123, title: 'Confirmed' },
  ]);
});
