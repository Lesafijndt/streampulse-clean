import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPostgresStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { handlePublicQueue } from '../server/public-queue.js';
import { getPlaybackGeneration } from '../src/playerBridge.js';
import { lookupQueueMetadata } from '../server/queue-metadata.js';
const namespace = 'release-verification-' + randomUUID(), db = await getPostgresStore(namespace);
const prefix = `artifacts/${namespace}/public/data/`;
const response = () => ({ status(n) { this.code = n; return this; }, setHeader() {}, json(body) { this.body = body; return this; } });
const call = async body => {
  const res = response(); await handlePrivateStore({ method: 'POST', body,
    headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app' } }, res,
  { login: '2o3a' }, { db, namespace }); return res;
};
try {
  for (const [id, status, queueOrder, pinned] of [['p', 'playing', 0, false], ['a', 'queue', 1, false], ['b', 'queue', 2, true], ['c', 'queue', 3, false], ['h', 'watched', 4, false]]) {
    await db.doc(prefix + 'queue_videos/' + id).set({ id, channelRoom: '2o3a', status, queueOrder, pinned,
      timestamp: 100, title: 'YouTube Media (dQw4w9WgXcQ)', platform: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ',
      requestedBy: 'ordinary_viewer', privateField: 'must-not-leak', durationSource: 'unknown' });
  }
  const before = await db.readState(), playing = before.documents[prefix + 'queue_videos/p'];
  assert.equal((await call({ operation: 'shuffle', expectedVersion: before.version })).code, 200);
  assert.equal((await call({ operation: 'shuffle', expectedVersion: before.version })).code, 409);
  const shuffled = await db.readState();
  assert.deepEqual(shuffled.documents[prefix + 'queue_videos/p'], playing);
  assert.deepEqual(shuffled.documents[prefix + 'queue_videos/h'], before.documents[prefix + 'queue_videos/h']);
  assert.equal(shuffled.documents[prefix + 'queue_videos/b'].queueOrder, 2000);
  const metadataBody = { operation: 'enrich-metadata', id: 'p', url: playing.url, generation: getPlaybackGeneration(playing),
    patch: { title: 'Verified metadata', durationSec: 213, status: 'watched' } };
  assert.equal((await call({ ...metadataBody, generation: 'stale' })).body.applied, false);
  assert.equal((await call(metadataBody)).body.applied, true);
  const after = await db.readState();
  assert.equal(after.documents[prefix + 'queue_videos/p'].status, 'playing');
  const publicResponse = response(); await handlePublicQueue({ method: 'GET' }, publicResponse, { db, namespace });
  assert.equal(publicResponse.code, 200); assert.equal(publicResponse.body.queue.length, 3);
  assert.equal(publicResponse.body.playing.title, 'Verified metadata');
  assert.equal(JSON.stringify(publicResponse.body).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(publicResponse.body).includes('"h"'), false);
  console.log(JSON.stringify({ check: 'live_queue_release', ok: true, atomicShuffle: true, staleVersionRejected: true,
    pinnedSlotPreserved: true, playingAndHistoryPreserved: true, metadataGenerationGuard: true, publicWhitelist: true, chatMessagesSent: 0 }));
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.tiktok.com/@scout2015/video/6718335390845095173']) {
    const metadata = await lookupQueueMetadata(url);
    console.log(JSON.stringify({ check: 'live_provider_metadata', provider: new URL(url).hostname, title: metadata?.title || '', durationSec: metadata?.durationSec || null }));
  }
} finally {
  const state = await db.readState(); await db.commitOperations(Object.keys(state.documents).map(path => ({ type: 'delete', path })));
}
