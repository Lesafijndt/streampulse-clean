import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicQueue } from '../server/public-queue.js';
import { handlePrivateStore } from '../server/private-store-api.js';
import { createDocumentStore } from '../server/postgres-store.js';
import { spawnSync } from 'node:child_process';

const namespace = 'streampulse-live-deck';
const prefix = `artifacts/${namespace}/public/data/`;
const path = id => prefix + 'queue_videos/' + id;
const row = (id, extra = {}) => ({ id, channelRoom: '2o3a', status: 'queue', title: id, url: 'https://example.com/' + id,
  requestedBy: 'viewer', platform: 'youtube', durationSec: 90, queueOrder: 1000, ...extra });
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('session public queue action bypasses Twitch authentication and returns storage failure when unconfigured', () => {
  const script = `import handler from './api/twitch/session.js';
    const res = { setHeader(){}, status(code){this.code=code;return this}, json(body){console.log(JSON.stringify({code:this.code,body}));return this} };
    await handler({method:'GET',query:{action:'queue-view'},headers:{}},res);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', POSTGRES_URL: '', TWITCH_CLIENT_ID: '' }
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.code, 503);
  assert.equal(typeof result.body.error, 'string');
  assert.equal(Object.hasOwn(result.body, 'authenticated'), false);
});

test('anonymous public view projects only playing and ordered waiting rows, caches ten seconds and never writes', async () => {
  let reads = 0;
  const documents = {
    [path('second')]: row('second', { queueOrder: 2000, secret: 'private token' }),
    [path('first')]: row('first'), [path('live')]: row('live', { status: 'playing' }),
    [path('history')]: row('history', { status: 'watched' }), [path('later')]: row('later', { status: 'watch_later' }),
    [path('other-room')]: row('other-room', { channelRoom: 'other' }),
    [prefix + 'user_profiles/2o3a']: { token: 'private token' },
    [path('nested') + '/child']: row('nested')
  };
  const db = { readState: async options => { reads++; assert.deepEqual(options.collections, [prefix + 'queue_videos',prefix + 'room_settings']); return { documents }; } };
  let now = 100;
  const call = async method => { const res = response(); await handlePublicQueue({ method }, res, { db, namespace, now: () => now }); return res; };
  const res = await call('GET');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.queue.map(item => item.id), ['first', 'second']);
  assert.equal(res.body.playing.id, 'live');
  assert.deepEqual(Object.keys(res.body.queue[0]).sort(), ['durationSec', 'id', 'platform', 'position', 'promotionLabel', 'promotionQuote', 'requestedBy', 'timestamp', 'title', 'url']);
  assert.deepEqual(res.body.queue.map(item => item.position), [1, 2]);
  assert.equal(JSON.stringify(res.body).includes('private token'), false);
  assert.equal(res.headers['Cache-Control'], 'public, max-age=0, s-maxage=10');
  now = 10099; await call('GET'); assert.equal(reads, 1);
  now = 10100; await call('GET'); assert.equal(reads, 2);
  assert.equal((await call('POST')).statusCode, 405);
  assert.equal(reads, 2);
});

test('public storage failure returns a safe uncached error', async () => {
  const res = response();
  await handlePublicQueue({ method: 'GET' }, res, { namespace, db: { readState: async () => { throw new Error('SECRET DATABASE CREDENTIAL'); } } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
});

test('staff shuffle atomically merges ranks, preserves pinned and nonqueue rows, and rejects stale concurrent versions', async () => {
  const documents = Object.fromEntries([
    row('a'), row('pin', { queueOrder: 2000, pinned: true }), row('b', { queueOrder: 3000, audioOnly: true }),
    row('live', { status: 'playing' }), row('history', { status: 'watched' }), row('later', { status: 'watch_later' }), row('other', { channelRoom: 'other' })
  ].map(item => [path(item.id), item]));
  let state = { version: 0, documents: structuredClone(documents) };
  let race = false;
  const db = createDocumentStore({ namespace, readState: async () => structuredClone(state), compareAndSwap: async (version, next) => {
    if (race) { race = false; state.documents[path('new')] = row('new'); state.version++; }
    if (version !== state.version) return false;
    state = { version: version + 1, documents: structuredClone(next) }; return true;
  } });
  const call = async (expectedVersion, login = '2o3a') => {
    const res = response();
    await handlePrivateStore({ method: 'POST', headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app' }, body: { operation: 'shuffle', expectedVersion } }, res, { login }, { namespace, db, random: () => 0 });
    return res;
  };
  assert.equal((await call(0, 'viewer')).statusCode, 403);
  assert.equal((await call(undefined)).statusCode, 400);
  assert.equal((await call(0)).statusCode, 200);
  assert.equal(state.documents[path('b')].queueOrder, 1000);
  assert.equal(state.documents[path('a')].queueOrder, 3000);
  for (const id of ['pin', 'live', 'history', 'later', 'other']) assert.deepEqual(state.documents[path(id)], documents[path(id)]);
  assert.deepEqual({ ...state.documents[path('b')], queueOrder: 3000 }, documents[path('b')]);
  assert.equal((await call(0)).statusCode, 409);
  race = true;
  const before = structuredClone(state.documents);
  assert.equal((await call(1)).statusCode, 409);
  assert.ok(state.documents[path('new')]);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(state.documents[key], value);
});
