import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { createPrivateCloudDb, resetPrivateCloud, onSnapshot, collection, doc, getDocs, setDoc, writeBatch, runTransaction } from '../src/cloudStore.js';

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

test('chat command claims require the matching staff role and can only claim a recent server-created packet once',async()=>{
  const {db}=setup({[prefix+'room_settings/2o3a']:{channelRoom:'2o3a',chatCommandFeed:[{id:'chat-a',at:Date.now(),volumeCommand:{action:'set',value:50}},{id:'chat-r',at:Date.now(),reply:'Command response'}]}});
  const body={operation:'claim-chat-command',id:'chat-a',kind:'audio'};
  assert.equal((await api(db,{method:'POST',body})).statusCode,403);
  assert.equal((await api(db,{method:'POST',body,login:'2o3a'})).body.claimed,true);
  assert.equal((await api(db,{method:'POST',body,login:'2o3a'})).body.claimed,false);
  assert.equal((await api(db,{method:'POST',body:{...body,id:'missing'},login:'2o3a'})).body.claimed,false);
  assert.equal((await api(db,{method:'POST',body:{...body,id:'chat-r',kind:'reply'}})).body.claimed,true);
});

test('scoped reset is authenticated, confirmed, atomic and preserves playing/history/credentials', async () => {
  const { db, state } = setup({ [prefix + 'queue_videos/a']: row('a'),
    [prefix + 'queue_videos/p']: row('p', { status: 'playing' }),
    [prefix + 'queue_videos/h']: row('h', { status: 'watched' }),
    [prefix + 'user_profiles/2o3a']: { preferences: { volume: 25 } },
    [prefix + 'queue_events/e']: { at: 1 }, [prefix + 'twitch_eventsub_receipts/r']: { status: 'queued' } });
  const body = { operation: 'reset', scope: 'queue', confirmation: 'RESET', expectedVersion: 0 };
  assert.equal((await api(db, { method: 'POST', body, login: 'gachibot69' })).statusCode, 403);
  assert.equal((await api(db, { method: 'POST', body: { ...body, confirmation: '' } })).statusCode, 400);
  assert.equal((await api(db, { method: 'POST', body, origin: 'https://evil.test' })).statusCode, 403);
  assert.equal((await api(db, { method: 'POST', body, login: '2o3a' })).statusCode, 200);
  assert.equal(state().documents[prefix + 'queue_videos/a'], undefined);
  assert.ok(state().documents[prefix + 'queue_videos/p']);
  assert.ok(state().documents[prefix + 'queue_videos/h']);
  assert.ok(state().documents[prefix + 'user_profiles/2o3a']);
  assert.ok(state().documents[prefix + 'twitch_eventsub_receipts/r']);
  assert.equal((await api(db, { method: 'POST', body })).statusCode, 409);
  assert.equal((await api(db, { method: 'POST', body: { ...body, scope: 'statistics', expectedVersion: 1 } })).statusCode, 200);
  assert.ok(state().documents[prefix + 'room_settings/2o3a'].statisticsResetAt > 1);
  assert.ok(state().documents[prefix + 'queue_events/e']);
  assert.ok(state().documents[prefix + 'queue_videos/p']);
  assert.equal((await api(db, { method: 'POST', body: { ...body, scope: 'history', expectedVersion: 2 } })).statusCode, 200);
  assert.equal(state().documents[prefix + 'queue_videos/h'], undefined);
  assert.equal((await api(db, { method: 'POST', body: { ...body, scope: 'all', expectedVersion: 3 } })).statusCode, 200);
  assert.equal(state().documents[prefix + 'queue_videos/p'], undefined);
  assert.ok(state().documents[prefix + 'user_profiles/2o3a']);
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

test('reset sends the reviewed version without refreshing away a newly arrived request conflict', async t => {
  const { db, state } = setup({ [prefix + 'queue_videos/a']: row('a') });
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(options.method || 'GET');
    const res = await api(db, { method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    return Response.json(res.body, { status: res.statusCode });
  };
  t.after(() => { globalThis.fetch = original; });
  const browser = createPrivateCloudDb(); browser.version = 0;
  await db.doc(prefix + 'queue_videos/new').set(row('new'));
  await assert.rejects(resetPrivateCloud(browser, 'queue'), /Queue changed/);
  assert.deepEqual(calls, ['POST']);
  assert.ok(state().documents[prefix + 'queue_videos/a']);
  assert.ok(state().documents[prefix + 'queue_videos/new']);
});


test('delta API scopes changed documents and never reads or exposes private collections', async () => {
  let selected;
  const db = { getVersion: async () => 4, readState: () => assert.fail('delta fetched whole state'),
    readChanges: async (since, options) => { assert.equal(since, 1); selected = options.collections;
      return { version: 4, reset: false, documents: {
        [prefix + 'queue_videos/a']: row('a', { status: 'playing' }),
        [prefix + 'queue_videos/deleted']: null,
        [prefix + 'queue_videos/moved']: row('moved', { channelRoom: 'other' }),
        [prefix + 'room_settings/other']: { secret: true },
        [prefix + 'twitch_eventsub_receipts/private']: { secret: true },
      } }; } };
  const res = await api(db, { since: 1 });
  assert.equal(res.statusCode, 200); assert.equal(res.body.delta, true);
  assert.deepEqual(selected, [prefix + 'queue_videos', prefix + 'room_settings']);
  assert.deepEqual(res.body.changes.map(change => [change.id, change.data?.status ?? null]), [['a', 'playing'], ['deleted', null], ['moved', null]]);
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('browser applies validated deltas atomically and pauses polling while hidden', async t => {
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const listeners = new Set(), timers = new Map(); let nextTimer = 0, calls = 0, failure;
  const surface = { hidden: false, addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  globalThis.document = surface;
  globalThis.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  globalThis.clearTimeout = id => timers.delete(id);
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
  const bodies = [
    { version: 1, legacyImported: true, collections: { queue_videos: [{ id: 'a', data: row('a') }, { id: 'keep', data: row('keep') }], room_settings: [] } },
    { version: 2, delta: true, changes: [{ collection: 'queue_videos', id: 'a', data: row('a', { status: 'playing' }) }, { collection: 'queue_videos', id: 'b', data: row('b') }] },
    { version: 3, delta: true, changes: [{ collection: 'queue_videos', id: 'a', data: null }] },
    { version: 4, delta: true, changes: [{ collection: 'queue_videos', id: 'keep', data: null }, { collection: 'private', id: 'bad', data: {} }] },
    { version: 4, delta: true, changes: [] },
  ];
  globalThis.fetch = async url => { assert.ok(url.includes('since=')); calls++; return Response.json(bodies.shift()); };
  const db = createPrivateCloudDb(), ref = collection(db, 'artifacts', namespace, 'public', 'data', 'queue_videos');
  const observed = []; const stop = onSnapshot(ref, value => observed.push(value.docs.map(doc => doc.id)), error => { failure = error; });
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const poll = async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); await settle(); };
  await settle(); assert.equal(db.version, 1);
  await poll(); assert.equal(db.version, 2); assert.equal(db.collections.queue_videos.find(row => row.id === 'a').data.status, 'playing');
  await poll(); assert.equal(db.version, 3); assert.deepEqual(db.collections.queue_videos.map(row => row.id), ['keep', 'b']);
  const before = structuredClone(db.collections);
  await poll(); assert.equal(failure.code, 'invalid_cloud_session'); assert.equal(db.version, 3); assert.deepEqual(db.collections, before);
  surface.hidden = true; for (const fn of listeners) fn(); assert.equal(timers.size, 0);
  assert.equal(calls, 4);
  surface.hidden = false; for (const fn of listeners) fn(); await settle();
  assert.equal(calls, 5); assert.equal(db.version, 4); assert.equal(timers.size, 1);
  stop(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); assert.ok(observed.length >= 3);
});

test('delta retention gap falls back to a scoped full snapshot including legacy import marker', async () => {
  let selection;
  const db = { getVersion: async () => 8, readChanges: async () => ({ version: 8, documents: {}, reset: true }),
    readState: async options => { selection = options.collections; return { version: 8, documents: {
      [prefix + 'queue_videos/new']: row('new'),
      [prefix + 'queue_videos/foreign']: row('foreign', { channelRoom: 'other' }),
      [prefix + 'system_diagnostics/legacy-browser-import']: { importedAt: 1 },
    } }; } };
  const res = await api(db, { since: 1 });
  assert.equal(res.body.delta, undefined); assert.equal(res.body.legacyImported, true);
  assert.deepEqual(res.body.collections.queue_videos.map(row => row.id), ['new']);
  assert.deepEqual(selection, ['queue_videos', 'room_settings', 'system_diagnostics'].map(name => prefix + name));
});

test('forced refresh callers serialize instead of racing newer snapshots into false login failures', async t => {
  const original = globalThis.fetch;
  const pending = []; let active = 0, peak = 0, version = 0;
  globalThis.fetch = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => pending.push(resolve));
    active--; version++;
    return Response.json({ version, legacyImported: true, collections: { queue_videos: [], room_settings: [] } });
  };
  t.after(() => { globalThis.fetch = original; });
  const browser = createPrivateCloudDb();
  const refs = collection(browser, 'artifacts', namespace, 'public', 'data', 'queue_videos');
  const calls = [getDocs(refs), getDocs(refs), getDocs(refs)];
  for (let index = 0; index < 3; index++) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, index + 1);
    pending[index]();
  }
  await Promise.all(calls);
  assert.equal(peak, 1);
  assert.equal(browser.version, 3);
});
