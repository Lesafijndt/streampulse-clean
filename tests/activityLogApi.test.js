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
