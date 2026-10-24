import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresStore } from '../server/postgres-store.js';
import { persistChatEvent } from '../server/webhook-queue.js';

if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw Error('Postgres connection missing');
const originalNamespace = process.env.VITE_FIREBASE_NAMESPACE;
const namespace = 'verification-' + randomUUID();
process.env.VITE_FIREBASE_NAMESPACE = namespace;
const db = await getPostgresStore(namespace);
const event = { broadcaster_user_login: '2o3a', chatter_user_login: 'verification_viewer',
  message: { text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } };
try {
  const first = await persistChatEvent(db, { event, messageId: 'first', subscriptionId: 'one' });
  assert.equal(first.queued, 1);
  const duplicate = await persistChatEvent(db, { event, messageId: 'first', subscriptionId: 'replacement' });
  assert.equal(duplicate.status, 'duplicate_delivery');
  const rows = db.collection('artifacts').doc(namespace).collection('public').doc('data').collection('queue_videos');
  const snapshot = await rows.get(); assert.equal(snapshot.size, 1);
  await snapshot.docs[0].ref.update({ status: 'watched', playedAt: Date.now() });
  const replay = await persistChatEvent(db, { event, messageId: 'second', subscriptionId: 'replacement' });
  assert.equal(replay.queued, 1);
  const after = await rows.get();
  assert.equal(after.docs.filter(row => row.data().status === 'queue').length, 1);
  assert.equal(after.docs.filter(row => row.data().status === 'watched').length, 1);
  const state = await db.readState(); assert.ok(state.version >= 3);
  console.log(JSON.stringify({ check: 'postgres_live_transactions', ok: true,
    viewerRequest: true, crossSubscriptionDedup: true, historyReplay: true, isolatedNamespace: true }));
} finally {
  // Only documents under the explicitly isolated verification namespace are
  // cleaned up. The live queue and its original Firestore data are untouched.
  const state = await db.readState();
  await db.commitOperations(Object.keys(state.documents).map(path => ({ type: 'delete', path })));
  if (originalNamespace === undefined) delete process.env.VITE_FIREBASE_NAMESPACE;
  else process.env.VITE_FIREBASE_NAMESPACE = originalNamespace;
}
