import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { createPrivateCloudDb, collection, doc, getDocs, setDoc, writeBatch, runTransaction } from '../src/cloudStore.js';

const namespace = 'streampulse-live-deck', prefix = `artifacts/${namespace}/public/data/`;
const row = (id, extra = {}) => ({ id, channelRoom: '2o3a', status: 'queue', timestamp: 100,
  url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Video', ...extra });
function setup(documents = {}) {
  let state = { version: 0, documents: structuredClone(documents) };
  const db = createDocumentStore({ namespace, readState: async () => structuredClone(state),
    compareAndSwap: async (version, next) => {
      if (version !== state.version) return false;
      state = { version: version + 1, documents: structuredClone(next) }; return true;
    } });
  return { db, state: () => state };
}
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
async function api(db, { method = 'GET', body, since, login = 'paim_beach_pete', origin = 'https://streampulse-clean.vercel.app' } = {}) {
  const res = response(); await handlePrivateStore({ method, body, query: { since }, headers: { origin,
    host: 'streampulse-clean.vercel.app' } }, res, { login }, { db, namespace }); return res;
}
test('private store reads reject viewers and never expose profiles, receipts or technical data', async () => {
  const { db } = setup({ [prefix + 'queue_videos/a']: row('a'), [prefix + 'user_profiles/paim_beach_pete']: { secret: true },
    [prefix + 'twitch_eventsub_receipts/r']: { sender: 'private' }, [prefix + 'room_settings/2o3a']: { streamSettings: { queueOpen: true } } });
  assert.equal((await api(db, { login: 'viewer' })).statusCode, 403);
  const result = await api(db, { login: '2o3a' });
  assert.deepEqual(Object.keys(result.body.collections).sort(), ['queue_videos', 'room_settings']);
  assert.equal(JSON.stringify(result.body).includes('secret'), false);
  assert.equal((await api(db, { since: 0 })).body.unchanged, true);
});
test('same-origin, namespace, moderator settings and append-only activity checks remain enforced', async () => {
  const { db, state } = setup();
  const payload = { expectedVersion: 0, expectations: {}, operations: [{ type: 'set', path: prefix + 'room_settings/2o3a', data: { streamSettings: { queueOpen: false } } }] };
  assert.equal((await api(db, { method: 'POST', body: payload, origin: 'https://attacker.test' })).statusCode, 403);
  assert.equal((await api(db, { method: 'POST', body: payload, login: '2o3a' })).statusCode, 403);
  payload.operations[0].path = 'artifacts/other/public/data/queue_videos/a';
  assert.equal((await api(db, { method: 'POST', body: payload })).statusCode, 403);
  payload.operations[0] = { type: 'set', path: prefix + 'queue_events/fake', data: { type: 'grant_admin', id: 'fake' } };
  assert.equal((await api(db, { method: 'POST', body: payload })).statusCode, 400);
  assert.equal(state().version, 0);
});
test('merge-only browser import preserves accepted cloud requests and runs at most once', async () => {
  const { db, state } = setup({ [prefix + 'queue_videos/a']: row('a', { title: 'new accepted cloud row' }) });
  const body = { operation: 'import-cache', videos: [row('a', { title: 'old cache' }), row('b', { status: 'watched' })] };
  assert.equal((await api(db, { method: 'POST', body })).statusCode, 200);
  assert.equal(state().documents[prefix + 'queue_videos/a'].title, 'new accepted cloud row');
  assert.equal(state().documents[prefix + 'queue_videos/b'].status, 'watched');
  await api(db, { method: 'POST', body: { operation: 'import-cache', videos: [row('c')] } });
  assert.equal(state().documents[prefix + 'queue_videos/c'], undefined);
});
test('stale playback generations cannot overwrite a newer request, while unrelated profile writes do not block Next', async () => {
  const { db, state } = setup({ [prefix + 'queue_videos/a']: row('a') });
  await db.doc(prefix + 'user_profiles/2o3a').set({ preferences: {} });
  const body = { expectedVersion: 0, operations: [{ type: 'update', path: prefix + 'queue_videos/a', data: { status: 'playing' } }],
    expectations: { [prefix + 'queue_videos/a']: { exists: true, timestamp: 100, status: 'queue' } } };
  assert.equal((await api(db, { method: 'POST', body })).statusCode, 200);
  assert.equal(state().documents[prefix + 'queue_videos/a'].status, 'playing');
  await db.doc(prefix + 'queue_videos/a').set(row('a', { timestamp: 200 }));
  assert.equal((await api(db, { method: 'POST', body })).statusCode, 409);
  assert.equal(state().documents[prefix + 'queue_videos/a'].timestamp, 200);
});
test('browser transport exercises real private API transaction, batch and authentication failure preservation', async t => {
  const { db, state } = setup({ [prefix + 'queue_videos/a']: row('a') });
  const original = globalThis.fetch; let expired = false;
  globalThis.fetch = async (url, options = {}) => {
    if (expired) return Response.json({ authenticated: false });
    const query = new URL(url, 'https://streampulse-clean.vercel.app').searchParams;
    const res = await api(db, { method: options.method || 'GET', since: query.get('since'),
      body: options.body ? JSON.parse(options.body) : undefined });
    return Response.json(res.body, { status: res.statusCode });
  };
  t.after(() => { globalThis.fetch = original; });
  const browser = createPrivateCloudDb(); const videos = collection(browser, 'artifacts', namespace, 'public', 'data', 'queue_videos');
  assert.equal((await getDocs(videos)).docs.length, 1);
  await runTransaction(browser, async tx => {
    const snap = await tx.get(doc(videos, 'a')); assert.equal(snap.data().timestamp, 100);
    tx.set(doc(videos, 'a'), { ...snap.data(), status: 'playing' });
  });
  assert.equal(state().documents[prefix + 'queue_videos/a'].status, 'playing');
  const batch = writeBatch(browser); batch.set(doc(videos, 'a'), { ...row('a'), status: 'watched' }, { merge: true });
  batch.set(doc(videos, 'b'), row('b')); await batch.commit();
  assert.equal(state().documents[prefix + 'queue_videos/b'].status, 'queue');
  expired = true; const previous = structuredClone(browser.collections);
  await assert.rejects(getDocs(videos), /session unavailable/);
  assert.deepEqual(browser.collections, previous);
  await assert.rejects(setDoc(doc(videos, 'c'), row('c')), /session unavailable/);
});
