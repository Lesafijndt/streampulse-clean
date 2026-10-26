import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { persistChatEvent } from '../server/webhook-queue.js';

const namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck';
const base = `artifacts/${namespace}/public/data`;
const path = id => `${base}/queue_videos/${id}`;
function memoryStore(options = {}) {
  let state = { version: 0, documents: {} };
  let conflicts = 0;
  const db = createDocumentStore({ namespace, ...options,
    readState: async () => structuredClone(state),
    compareAndSwap: async (version, documents) => {
      if (state.version !== version) { conflicts++; return false; }
      state = { version: version + 1, documents: structuredClone(documents) };
      return true;
    },
  });
  return { db, conflicts: () => conflicts };
}
const increment = value => ({ __op: 'increment', value });
const arrayUnion = (...values) => ({ __op: 'arrayUnion', values });

test('an empty top-level merge preserves the full video while nested empty maps still replace their map', async () => {
  const { db } = memoryStore(); const ref = db.doc(path('unchanged'));
  const original = { id: 'unchanged', channelRoom: '2o3a', status: 'queue', title: 'Keep this video', prefs: { a: 1 } };
  await ref.set(original); await ref.set({}, { merge: true });
  assert.deepEqual((await ref.get()).data(), original);
  await ref.set({ prefs: {} }, { merge: true });
  assert.deepEqual((await ref.get()).data(), { ...original, prefs: {} });
});

test('concurrent transactions retry their reads and preserve both updates', async () => {
  const { db, conflicts } = memoryStore();
  const counter = db.doc(path('counter'));
  await counter.set({ count: 0 });
  const visits = [0, 0];
  const results = await Promise.all([0, 1].map(index => db.runTransaction(async tx => {
    visits[index]++;
    const current = await tx.get(counter);
    tx.update(counter, { count: current.get('count') + 1 });
    return current.get('count') + 1;
  })));
  assert.equal((await counter.get()).get('count'), 2);
  assert.deepEqual(results.sort(), [1, 2]);
  assert.ok(conflicts() >= 1);
  assert.ok(visits.some(value => value > 1));
});

test('concurrent Twitch delivery is journaled once and queue history survives replay', async () => {
  const { db } = memoryStore();
  const args = { messageId: 'postgres-delivery-a', subscriptionId: 'sub-a', event: {
    broadcaster_user_login: '2o3a', chatter_user_login: 'ordinary_viewer',
    message: { text: 'https://youtu.be/dQw4w9WgXcQ' },
  } };
  const first = await Promise.all([persistChatEvent(db, args), persistChatEvent(db, args)]);
  assert.deepEqual(first.map(item => item.status).sort(), ['duplicate_delivery', 'queued']);
  const queue = db.collection(`${base}/queue_videos`);
  assert.equal((await queue.get()).size, 1);
  assert.equal((await db.collection(`${base}/twitch_eventsub_receipts`).get()).size, 1);
  const original = (await queue.get()).docs[0];
  await original.ref.update({ status: 'watched', playedAt: 12345, retained: { votes: [1, 2] } });
  const replay = await persistChatEvent(db, { ...args, messageId: 'postgres-delivery-b' });
  assert.equal(replay.status, 'queued');
  const rows = (await queue.get()).docs;
  assert.equal(rows.length, 2);
  const history = rows.find(row => row.id.startsWith('history-'));
  assert.equal(history.get('status'), 'watched');
  assert.equal(history.get('playedAt'), 12345);
  assert.deepEqual(history.get('retained'), { votes: [1, 2] });
  assert.equal((await original.ref.get()).get('status'), 'queue');
});

test('concurrent different delivery IDs for the same media create one queue item', async () => {
  const { db } = memoryStore();
  const event = { broadcaster_user_login: '2o3a', chatter_user_login: 'another_viewer',
    message: { text: 'https://youtu.be/dQw4w9WgXcQ' } };
  const results = await Promise.all(['message-a', 'message-b'].map(messageId =>
    persistChatEvent(db, { event, messageId, subscriptionId: 'sub' })));
  assert.deepEqual(results.map(item => item.status).sort(), ['duplicate_media', 'queued']);
  assert.equal((await db.collection(`${base}/queue_videos`).get()).size, 1);
  assert.equal((await db.collection(`${base}/twitch_eventsub_receipts`).get()).size, 2);
});

test('callback and batch validation failures roll back all staged mutations', async () => {
  const { db } = memoryStore();
  const existing = db.doc(path('existing'));
  await existing.set({ keep: 'original' });
  const before = await db.readState();
  await assert.rejects(db.runTransaction(async tx => {
    tx.update(existing, { keep: 'changed' });
    tx.create(db.doc(path('new')), { data: 1 });
    throw new Error('callback aborted');
  }), /callback aborted/);
  assert.deepEqual(await db.readState(), before);
  const batch = db.batch();
  batch.update(existing, { keep: 'changed' });
  batch.create(existing, { accidental: true });
  await assert.rejects(batch.commit(), { code: 'already_exists' });
  assert.deepEqual(await db.readState(), before);
});

test('merges, dotted updates and transforms preserve unrelated document data', async () => {
  const { db } = memoryStore();
  const ref = db.doc(path('item'));
  await ref.set({ count: 2, voters: ['alice'], nested: { keep: 1, edit: 2 }, emptyMe: { old: true } });
  await ref.set({ count: increment(3), voters: arrayUnion('alice', 'bob'), nested: { edit: 4 }, emptyMe: {}, skip: undefined }, { merge: true });
  assert.deepEqual((await ref.get()).data(), {
    count: 5, voters: ['alice', 'bob'], nested: { keep: 1, edit: 4 }, emptyMe: {},
  });
  await ref.update({ 'nested.edit': increment(2), voters: arrayUnion({ id: 1 }, { id: 1 }) });
  assert.equal((await ref.get()).get('nested.edit'), 6);
  assert.deepEqual((await ref.get()).get('voters'), ['alice', 'bob', { id: 1 }]);
  await ref.update({ nested: { only: true } });
  assert.deepEqual((await ref.get()).get('nested'), { only: true });
  await ref.set({ replacement: true });
  assert.deepEqual((await ref.get()).data(), { replacement: true });
});

test('concurrent standalone increments retry without losing either vote', async () => {
  const { db } = memoryStore();
  const ref = db.doc(path('votes'));
  await ref.set({ count: 0, voters: [] });
  await Promise.all(['alice', 'bob'].map(name => ref.update({ count: increment(1), voters: arrayUnion(name) })));
  const data = (await ref.get()).data();
  assert.equal(data.count, 2);
  assert.deepEqual(data.voters.sort(), ['alice', 'bob']);
});

test('queries paginate tied timestamps by document ID and scope direct children', async () => {
  const { db } = memoryStore();
  const collection = db.collection('artifacts').doc(namespace).collection('public').doc('data').collection('queue_events');
  const batch = db.batch();
  for (const [id, at] of [['c', 20], ['b', 10], ['a', 10], ['d', 30]]) batch.set(collection.doc(id), { at, room: id === 'd' ? 'other' : '2o3a' });
  batch.set(db.doc(path('unrelated')), { at: 0, room: '2o3a' });
  await batch.commit();
  const query = collection.where('room', '==', '2o3a').orderBy('at', 'asc').orderBy({}, 'asc');
  const page = await query.limit(2).get();
  assert.deepEqual(page.docs.map(row => row.id), ['a', 'b']);
  assert.equal(page.size, 2);
  assert.equal(page.empty, false);
  assert.deepEqual((await query.startAfter(10, 'b').get()).docs.map(row => row.id), ['c']);
  assert.deepEqual((await query.startAfter(page.docs[1]).get()).docs.map(row => row.id), ['c']);
  assert.deepEqual((await collection.orderBy('at', 'desc').limit(2).get()).docs.map(row => row.id), ['d', 'c']);
  assert.deepEqual((await collection.orderBy('at').startAfter(10).get()).docs.map(row => row.id), ['c', 'd']);
  assert.deepEqual((await collection.where('at', '>=', 20).get()).docs.map(row => row.id), ['c', 'd']);
  const snapshot = await db.runTransaction(tx => tx.get(query));
  assert.equal(snapshot.size, 3);
});

test('HTTP commit preconditions return 409 without overwriting a newer write', async () => {
  const { db } = memoryStore();
  const originalVersion = await db.getVersion();
  assert.deepEqual(await db.commitOperations([{ type: 'set', path: path('a'), data: { n: 1 } }], { expectedVersion: originalVersion }), { version: 1 });
  await assert.rejects(db.commitOperations([{ type: 'delete', path: path('a') }], { expectedVersion: originalVersion }), { code: 'conflict', status: 409 });
  assert.equal((await db.doc(path('a')).get()).exists, true);
  const version = await db.getVersion();
  const results = await Promise.allSettled(['b', 'c'].map(id => db.commitOperations([
    { type: 'create', path: path(id), data: { id } },
  ], { expectedVersion: version })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal((await db.collection(`${base}/queue_videos`).get()).size, 2);
});

test('retry count is bounded for transactions and unconditioned commits', async () => {
  let attempts = 0;
  const db = createDocumentStore({ namespace, maxAttempts: 3,
    readState: async () => ({ version: 0, documents: {} }),
    compareAndSwap: async () => { attempts++; return false; },
  });
  let callbacks = 0;
  await assert.rejects(db.runTransaction(async tx => {
    callbacks++;
    tx.set(db.doc(path('a')), { value: 1 });
  }), { code: 'conflict', status: 409 });
  assert.equal(callbacks, 3);
  assert.equal(attempts, 3);
  await assert.rejects(db.doc(path('b')).set({ value: 2 }), { code: 'conflict' });
  assert.equal(attempts, 6);
});

test('reads return detached data and read-only transactions do not increase version', async () => {
  const { db } = memoryStore();
  const a = db.doc(path('a'));
  await a.set({ nested: { keep: true } });
  const snap = await a.get();
  snap.data().nested.keep = false;
  const state = await db.readState();
  state.documents[path('a')].nested.keep = false;
  const version = await db.getVersion();
  const all = await db.runTransaction(tx => tx.getAll(a, db.doc(path('missing'))));
  assert.equal(all[0].get('nested.keep'), true);
  assert.equal(all[1].exists, false);
  assert.equal(all[1].data(), undefined);
  assert.equal(await db.getVersion(), version);
});

test('invalid and cross-namespace writes cannot change state', async () => {
  const { db } = memoryStore();
  await assert.rejects(db.commitOperations([{ type: 'set', path: 'artifacts/other/public/data/queue_videos/a', data: { bad: true } }]), { code: 'invalid_document_path' });
  await assert.rejects(db.commitOperations([{ type: 'set', path: path('a'), data: JSON.parse('{"__proto__":{"polluted":true}}') }]), { code: 'invalid_document_key' });
  await assert.rejects(db.commitOperations([{ type: 'set', path: path('a'), data: { values: [undefined] } }]), { code: 'invalid_document_value' });
  await assert.rejects(db.commitOperations([{ type: 'set', path: path('a'), data: { count: increment(Infinity) } }]), { code: 'invalid_document_value' });
  assert.deepEqual(await db.readState(), { version: 0, documents: {} });
  assert.equal({}.polluted, undefined);
});

test('delete is idempotent, missing updates fail, and closed queue writes receipt only', async () => {
  const { db } = memoryStore();
  const ref = db.doc(path('missing'));
  await ref.delete();
  await assert.rejects(ref.update({ value: 1 }), { code: 'not_found' });
  await db.doc(`${base}/room_settings/2o3a`).set({ streamSettings: { queueOpen: false } });
  const result = await persistChatEvent(db, { messageId: 'closed-delivery', subscriptionId: 'sub', event: {
    broadcaster_user_login: '2o3a', chatter_user_login: 'ordinary_viewer', message: { text: 'https://youtu.be/dQw4w9WgXcQ' },
  } });
  assert.equal(result.status, 'closed');
  assert.equal((await db.collection(`${base}/queue_videos`).get()).size, 0);
  assert.equal((await db.collection(`${base}/twitch_eventsub_receipts`).get()).size, 1);
});
