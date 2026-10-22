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


test('activity log refreshes a persistent staff session when only the refresh cookie remains', async (t) => {
  const previous = {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    appUrl: process.env.TWITCH_APP_URL,
    nodeEnv: process.env.NODE_ENV,
    fetch: globalThis.fetch,
  };
  t.after(() => {
    for (const [key, value] of [
      ['TWITCH_CLIENT_ID', previous.clientId],
      ['TWITCH_CLIENT_SECRET', previous.clientSecret],
      ['FIREBASE_SERVICE_ACCOUNT_JSON', previous.serviceAccount],
      ['TWITCH_APP_URL', previous.appUrl],
      ['NODE_ENV', previous.nodeEnv],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = previous.fetch;
  });

  process.env.TWITCH_CLIENT_ID = 'test-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-client-secret';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
  process.env.TWITCH_APP_URL = '';
  process.env.NODE_ENV = 'test';

  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });

    if (url === 'https://id.twitch.tv/oauth2/token') {
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'remembered-refresh');
      return {
        ok: true,
        json: async () => ({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 14400,
        }),
      };
    }

    if (url === 'https://id.twitch.tv/oauth2/validate') {
      assert.equal(options.headers.Authorization, 'OAuth fresh-access');
      return {
        ok: true,
        json: async () => ({
          client_id: 'test-client-id',
          login: '2o3a',
          user_id: '1001',
          expires_in: 1200,
          scopes: [],
        }),
      };
    }

    throw new Error('Unexpected fetch URL in activity sync test: ' + url);
  };

  const res = responseMock();
  await handler({
    method: 'GET',
    headers: {
      host: 'whale-cum.test',
      origin: 'https://whale-cum.test',
      cookie: 'yedi_twitch_refresh=remembered-refresh',
    },
    query: { appId: 'invalid/namespace' },
  }, res);

  // Authentication succeeds and is renewed before the deliberately invalid namespace
  // is rejected, so this test does not need live Firebase credentials.
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Invalid activity namespace/i);
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://id.twitch.tv/oauth2/token',
    'https://id.twitch.tv/oauth2/validate',
  ]);

  const cookies = res.headers['Set-Cookie'];
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some((cookie) =>
    cookie.startsWith('yedi_twitch_access=fresh-access;') && cookie.includes('Max-Age=1200')
  ));
  assert.ok(cookies.some((cookie) =>
    cookie.startsWith('yedi_twitch_refresh=fresh-refresh;') && cookie.includes('Max-Age=34560000')
  ));
});
