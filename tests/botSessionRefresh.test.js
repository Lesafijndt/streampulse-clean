import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/twitch/bot-session.js';

test('expired bot access cookie renews from refresh cookie after reload without reconnecting', async t => {
  const original = global.fetch, client = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  t.after(() => { global.fetch = original; for (const [key, value] of [['TWITCH_CLIENT_ID', client], ['TWITCH_CLIENT_SECRET', secret]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.TWITCH_CLIENT_ID = 'test-client'; process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  let refreshed = false;
  global.fetch = async (url, options) => {
    if (url.endsWith('/oauth2/token')) {
      assert.equal(options.body.get('refresh_token'), 'long-lived'); refreshed = true;
      return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 14400 });
    }
    assert.ok(!options.headers.Authorization.includes('undefined'));
    return Response.json(options.headers.Authorization === 'OAuth staff'
      ? { client_id: 'test-client', login: 'paim_beach_pete' }
      : { client_id: 'test-client', login: 'gachibot69', user_id: 'bot', scopes: ['user:read:chat', 'user:write:chat'] });
  };
  const headers = {};
  const res = { setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', query: {}, headers: { cookie: 'yedi_twitch_access=staff; yedi_twitch_bot_refresh=long-lived' } }, res);
  assert.equal(refreshed, true); assert.equal(res.body.connected, true); assert.equal(res.body.canReadChat, true);
  assert.ok(headers['Set-Cookie'].some(value => value.startsWith('yedi_twitch_bot_refresh=rotated')));
  const outageHeaders = {};
  global.fetch = async (url, options) => {
    assert.ok(!url.endsWith('/oauth2/token'), 'A Twitch outage must not rotate a valid refresh token');
    return options.headers.Authorization === 'OAuth staff' ? Response.json({ client_id: 'test-client', login: 'paim_beach_pete' }) : Response.json({}, { status: 503 });
  };
  const outage = { ...res, setHeader(k, v) { outageHeaders[k] = v; }, getHeader(k) { return outageHeaders[k]; } };
  await handler({ method: 'GET', query: {}, headers: { cookie: 'yedi_twitch_access=staff; yedi_twitch_bot_access=access; yedi_twitch_bot_refresh=long-lived' } }, outage);
  assert.equal(outage.code, 503); assert.equal(outageHeaders['Set-Cookie'], undefined);
});
