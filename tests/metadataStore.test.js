import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { getPlaybackGeneration } from '../src/playerBridge.js';

test('metadata writes reject stale generations and preserve queue and custom fields', async () => {
  const namespace = 'metadata-test', path = `artifacts/${namespace}/public/data/queue_videos/a`;
  const video = { id: 'a', channelRoom: '2o3a', platform: 'youtube', title: 'YouTube Media (abcdefghijk)',
    url: 'https://youtu.be/abcdefghijk', timestamp: 1, playedAt: 2, status: 'playing', upvotes: 9, queueOrder: 500,
    durationSource: 'unknown' };
  let state = { version: 0, documents: { [path]: video } };
  const db = createDocumentStore({ namespace, readState: async () => structuredClone(state), compareAndSwap: async (v, docs) => {
    if (v !== state.version) return false;
    state = { version: v + 1, documents: structuredClone(docs) }; return true;
  } });
  const call = async (generation, title = 'Real title') => {
    const res = { status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await handlePrivateStore({ method: 'POST', headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app' },
      body: { operation: 'enrich-metadata', id: 'a', url: video.url, generation,
        patch: { title, durationSec: 42, durationProvider: 'test', status: 'watched', upvotes: 0 } } }, res,
    { login: '2o3a' }, { db, namespace }); return res;
  };
  assert.equal((await call('stale')).body.applied, false);
  assert.equal(state.version, 0);
  assert.equal((await call(getPlaybackGeneration(video))).body.applied, true);
  assert.equal(state.documents[path].title, 'Real title');
  assert.equal(state.documents[path].durationSec, 42);
  for (const key of ['status', 'upvotes', 'queueOrder', 'playedAt', 'timestamp']) assert.equal(state.documents[path][key], video[key]);
  assert.equal((await call(getPlaybackGeneration(video), 'Replacement title')).body.applied, false);
  assert.equal(state.documents[path].title, 'Real title');
});
