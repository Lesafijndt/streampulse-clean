import test from 'node:test';
import assert from 'node:assert/strict';
import subscribe from '../server/chat-subscribe.js';
import { readFile } from 'node:fs/promises';

function response() {
  const headers = new Map();
  return {
    headers, statusCode: 200, body: null,
    getHeader: key => headers.get(key),
    setHeader(key, value) { headers.set(key, value); },
    status(n) { this.statusCode = n; return this; },
    json(data) { this.body = data; return this; },
  };
}
function request(cookie = '', body = { sessionId: 'twitch-session-123456789' }) {
  return { method: 'POST', headers: {
    host: 'streampulse-clean.vercel.app',
    'x-forwarded-proto': 'https',
    origin: 'https://streampulse-clean.vercel.app',
    cookie,
  }, body };
}
function installMockTwitch(t, { readScope = true } = {}) {
  const oldFetch = globalThis.fetch;
  const oldClient = process.env.TWITCH_CLIENT_ID;
  const oldSecret = process.env.TWITCH_CLIENT_SECRET;
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  let posted = null;
  globalThis.fetch = async (url, opts = {}) => {
    const dest = String(url);
    const auth = String(opts.headers?.Authorization || '');
    if (dest.includes('/oauth2/validate')) {
      if (auth.includes('staff-token')) return Response.json({
        client_id: 'test-client', login: 'paim_beach_pete', user_id: '111', scopes: [],
      });
      if (auth.includes('bot-token')) return Response.json({
        client_id: 'test-client', login: 'gachibot69', user_id: '222',
        scopes: readScope ? ['user:write:chat', 'user:read:chat'] : ['user:write:chat'],
      });
      return Response.json({}, { status: 401 });
    }
    if (dest.includes('/helix/users?login=2o3a')) return Response.json({ data: [{ id: '333' }] });
    if (dest.includes('/helix/eventsub/subscriptions')) {
      posted = { headers: opts.headers, body: JSON.parse(String(opts.body)) };
      return Response.json({ data: [{ status: 'enabled' }] }, { status: 202 });
    }
    throw new Error('Unexpected Twitch request: ' + dest);
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldClient === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = oldClient;
    if (oldSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = oldSecret;
  });
  return () => posted;
}

test('viewer and foreign-origin calls cannot establish a Twitch intake subscription', async () => {
  const wrongOrigin = request();
  wrongOrigin.headers.origin = 'https://attacker.example';
  const r1 = response();
  await subscribe(wrongOrigin, r1);
  assert.equal(r1.statusCode, 403);
  assert.equal(r1.body.code, 'origin_denied');
  const r2 = response();
  await subscribe({ method: 'GET', headers: {} }, r2);
  assert.equal(r2.statusCode, 405);
});

test('only moderator and authenticated bot create a Twitch EventSub subscription', async (t) => {
  const posted = installMockTwitch(t);
  const r1 = response();
  await subscribe(request(), r1);
  assert.equal(r1.statusCode, 401);
  assert.equal(r1.body.code, 'moderator_login_required');

  const r2 = response();
  await subscribe(request('yedi_twitch_access=staff-token; yedi_twitch_bot_access=bot-token'), r2);
  assert.equal(r2.statusCode, 201);
  assert.equal(r2.body.ok, true);
  assert.deepEqual(posted().body, {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: '333', user_id: '222' },
    transport: { method: 'websocket', session_id: 'twitch-session-123456789' },
  });
  assert.equal(posted().headers.Authorization, 'Bearer bot-token');
  assert.equal(JSON.stringify(r2.body).includes('bot-token'), false);
});

test('chat intake refuses stale bot OAuth grants without user:read:chat', async (t) => {
  installMockTwitch(t, { readScope: false });
  const res = response();
  await subscribe(request('yedi_twitch_access=staff-token; yedi_twitch_bot_access=bot-token'), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'bot_read_scope_missing');
});

test('queue writes discard undefined duration and require cloud confirmation', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /JSON\.parse\(JSON\.stringify\(\{ \.\.\.localItem, createdAt: Date\.now\(\) \}\)\)/);
  assert.match(app, /const confirmed = await syncAddVideo\(newVideo\)/);
  assert.match(app, /if \(!confirmed\) \{/);
  assert.match(app, /setChatBridgeStatus\('Chat request received; Firestore queue write failed'\)/);
  assert.match(app, /chatBotSession\.canReadChat && db && firebaseUser/);
  assert.match(app, /connectTwitchIrc\(target, \{ silent: true \}\)/);
  assert.doesNotMatch(app, /NICK justinfan/);
  assert.match(app, /chatBridgeLastMessageAt/);
});
