import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/activity-log.js';

function responseMock() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('activity log rejects unsupported methods without touching authentication providers', async () => {
  const req = { method: 'PUT', headers: { host: 'whale-cum.test' }, query: {} };
  const res = responseMock();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, POST');
  assert.match(res.body.error, /Method not allowed/i);
});

test('activity log rejects cross-origin reads before checking Twitch credentials', async () => {
  const req = { method: 'GET', headers: { host: 'whale-cum.test', origin: 'https://attacker.test' }, query: {} };
  const res = responseMock();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /originate from the dashboard/i);
});

test('activity log rejects browser writes with a missing Origin header', async () => {
  const req = { method: 'POST', headers: { host: 'whale-cum.test' }, body: { appId: 'streampulse-live-deck', event: {} } };
  const res = responseMock();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /originate from the dashboard/i);
});

test('activity log requests are never cacheable', async () => {
  const req = { method: 'GET', headers: { host: 'whale-cum.test', origin: 'https://whale-cum.test' }, query: {} };
  const res = responseMock();
  await handler(req, res);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(res.headers.Vary, 'Cookie');
  assert.ok([401, 503].includes(res.statusCode), 'unauthenticated request is denied without relying on live Twitch');
});


test('activity log API uses stable paginated Firestore reads, not full-history scans', async () => {
  const { readFile } = await import('node:fs/promises');
  const api = await readFile(new URL('../api/activity-log.js', import.meta.url), 'utf8');
  assert.match(api, /const PAGE_SIZE = 200/);
  assert.match(api, /orderBy\('at', 'asc'\)/);
  assert.match(api, /orderBy\(FieldPath\.documentId\(\), 'asc'\)/);
  assert.match(api, /startAfter\(at, afterId\)/);
  assert.match(api, /query\.limit\(PAGE_SIZE\)\.get\(\)/);
  assert.match(api, /nextCursor, hasMore:/);
  assert.doesNotMatch(api, /events\.orderBy\('at', 'asc'\)\.get\(\)/);
});

test('moderator activity refresh accumulates only new records, without rereading the collection', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const activityCursorRef = useRef\(\{ at: 0, id: '' \}\)/);
  assert.match(app, /params\.set\('afterAt', String\(cursor\.at\)\)/);
  assert.match(app, /params\.set\('afterId', cursor\.id\)/);
  assert.match(app, /activityCloudIdsRef\.current\.add\(String\(event\.id\)\)/);
  assert.match(app, /setInterval\(loadActivityEvents, 120000\)/);
  assert.doesNotMatch(app, /setInterval\(loadActivityEvents, 30000\)/);
});


test('quota exhaustion signals clients to back off instead of retrying activity reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const [api, app] = await Promise.all([
    readFile(new URL('../api/activity-log.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /res\.setHeader\('Retry-After', '3600'\)/);
  assert.match(api, /code: 'firestore_quota_exceeded'/);
  assert.match(app, /result\.code === 'firestore_quota_exceeded'/);
  assert.match(app, /Date\.now\(\) < nextAllowedFetchAt/);
  assert.match(app, /Math\.max\(3600, retrySeconds\)/);
});
