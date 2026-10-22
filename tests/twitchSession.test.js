import test from 'node:test';
import assert from 'node:assert/strict';
import sessionHandler from '../api/twitch/session.js';

function createResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers.set(name, value); },
    getHeader(name) { return headers.get(name); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('restores a Twitch dashboard session when only the persistent refresh cookie remains', async (t) => {
  const previous = {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    nodeEnv: process.env.NODE_ENV,
    fetch: globalThis.fetch,
  };
  t.after(() => {
    for (const [key, value] of [
      ['TWITCH_CLIENT_ID', previous.clientId],
      ['TWITCH_CLIENT_SECRET', previous.clientSecret],
      ['FIREBASE_SERVICE_ACCOUNT_JSON', previous.serviceAccount],
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
  process.env.NODE_ENV = 'test';

  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });

    if (url === 'https://id.twitch.tv/oauth2/token') {
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'refresh-old');
      return {
        ok: true,
        json: async () => ({
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_in: 14400,
        }),
      };
    }

    if (url === 'https://id.twitch.tv/oauth2/validate') {
      assert.equal(options.headers.Authorization, 'OAuth access-fresh');
      return {
        ok: true,
        json: async () => ({
          client_id: 'test-client-id',
          login: '2o3a',
          user_id: '1001',
          expires_in: 1200,
          scopes: ['user:read:email'],
        }),
      };
    }

    if (url === 'https://api.twitch.tv/helix/users') {
      assert.equal(options.headers.Authorization, 'Bearer access-fresh');
      return {
        ok: true,
        json: async () => ({
          data: [{ id: '1001', login: '2o3a', display_name: '2o3a' }],
        }),
      };
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const res = createResponse();
  await sessionHandler({
    method: 'GET',
    headers: { cookie: 'yedi_twitch_refresh=refresh-old' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authenticated, true);
  assert.equal(res.body.user.login, '2o3a');
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://id.twitch.tv/oauth2/token',
    'https://id.twitch.tv/oauth2/validate',
    'https://api.twitch.tv/helix/users',
  ]);

  const cookies = res.headers.get('Set-Cookie');
  assert.ok(Array.isArray(cookies));
  assert.ok(cookies.some((cookie) =>
    cookie.startsWith('yedi_twitch_access=access-fresh;') && cookie.includes('Max-Age=1200')
  ));
  assert.ok(cookies.some((cookie) =>
    cookie.startsWith('yedi_twitch_refresh=refresh-fresh;') && cookie.includes('Max-Age=34560000')
  ));
});
