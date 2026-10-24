import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTwitchSignature } from '../server/twitch-webhook.js';
import { extractChatRequests, makeQueueItems, persistChatEvent } from '../server/webhook-queue.js';
import { decodeServiceAccount, EXPECTED_FIREBASE_PROJECT } from '../server/firebase-guard.js';
import { readFile } from 'node:fs/promises';

test('Twitch webhook signature covers raw bytes and checks replay window', () => {
  const secret = '0123456789abcdefghijklmnopqrstuv';
  const raw = Buffer.from('{"payload":"hello"}');
  const timestamp = new Date().toISOString();
  const id = 'event-sub-message-123';
  const sig = 'sha256=' + createHmac('sha256', secret)
    .update(id).update(timestamp).update(raw).digest('hex');
  const args = { id, timestamp, rawBody: raw, signature: sig, secret };
  assert.equal(verifyTwitchSignature(args), true);
  assert.equal(verifyTwitchSignature({ ...args, rawBody: Buffer.from('{}') }), false);
  assert.equal(verifyTwitchSignature({ ...args, signature: 'sha256=' + '0'.repeat(64) }), false);
  assert.equal(verifyTwitchSignature({ ...args, now: Date.now() + 11 * 60 * 1000 }), false);
});

test('any Twitch viewer can request multiple distinct URLs without an account allowlist', async () => {
  const event = {
    broadcaster_user_login: '2o3a',
    chatter_user_login: 'random_viewer_123',
    message: { text: 'hello https://youtu.be/dQw4w9WgXcQ https://youtu.be/jfKfPfyJRdk' },
  };
  const result = await makeQueueItems(event);
  assert.equal(result.reason, 'ready');
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.requestedBy === 'random_viewer_123'));
  assert.ok(result.items.every(item => item.status === 'queue'));
  assert.equal(extractChatRequests('!assr dQw4w9WgXcQ').links.length, 1);
});

test('notification delivery and media writes occur in one idempotent transaction', async () => {
  const stored = new Map();
  const database = {
    collection(name) { return makeRef([name]); },
    runTransaction: async callback => {
      const patches = [];
      const tx = {
        async get(ref) {
          return { exists: stored.has(ref.id), data: () => stored.get(ref.id) };
        },
        create(ref, value) {
          if (stored.has(ref.id)) throw Error('already exists');
          patches.push([ref.id, value]);
        },
      };
      const result = await callback(tx);
      patches.forEach(([key,value]) => stored.set(key,value));
      return result;
    },
  };
  function makeRef(parts) {
    return {
      id: parts.join('/'),
      collection(name) { return makeRef([...parts,name]); },
      doc(id) { return makeRef([...parts,id]); },
    };
  }
  const args = {
    event: {
      broadcaster_user_login: '2o3a',
      chatter_user_login: 'ordinary_viewer',
      message: { text: 'https://youtu.be/dQw4w9WgXcQ' },
    },
    messageId: 'eventA', subscriptionId: 'subscription1',
  };
  const a = await persistChatEvent(database,args);
  assert.deepEqual({ status: a.status, queued: a.queued }, { status:'queued', queued:1 });
  const b = await persistChatEvent(database,args);
  assert.equal(b.status,'duplicate_delivery');
  assert.equal(stored.size,2);
  const c = await persistChatEvent(database,{...args,messageId:'eventB'});
  assert.equal(c.status,'duplicate_media');
  assert.equal(stored.size,3);
});

test('stale Firebase service account or web project cannot write into wrong project', () => {
  const savedRaw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const savedWeb=process.env.VITE_FIREBASE_PROJECT_ID;
  try {
    process.env.VITE_FIREBASE_PROJECT_ID=EXPECTED_FIREBASE_PROJECT;
    const fake={ project_id:'another-firebase-project',client_email:'service@example.iam.gserviceaccount.com',private_key:'placeholder' };
    assert.throws(() => decodeServiceAccount(JSON.stringify(fake)), error => error.code==='firebase_project_mismatch');
    fake.project_id=EXPECTED_FIREBASE_PROJECT;
    assert.equal(decodeServiceAccount(JSON.stringify(fake)).project_id, EXPECTED_FIREBASE_PROJECT);
    process.env.VITE_FIREBASE_PROJECT_ID='different-project';
    assert.throws(() => decodeServiceAccount(JSON.stringify(fake)), error => error.code==='firebase_project_mismatch');
  } finally {
    if(savedRaw===undefined)delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON=savedRaw;
    if(savedWeb===undefined)delete process.env.VITE_FIREBASE_PROJECT_ID;
    else process.env.VITE_FIREBASE_PROJECT_ID=savedWeb;
  }
});

test('signed webhook uses existing bot-session API endpoint; moderator UI never relies on open WebSocket', async () => {
  const [bot, app, login] = await Promise.all([
    readFile(new URL('../api/twitch/bot-session.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../api/twitch/bot-login.js', import.meta.url), 'utf8'),
  ]);
  assert.match(bot, /bodyParser: false/);
  assert.match(bot, /action === 'webhook'/);
  assert.match(bot, /action === 'webhook-setup'/);
  assert.match(login, /user:bot/);
  assert.match(app, /Twitch listening \(delivery not guaranteed\)/);
  assert.match(app, /activateTwitchWebhook/);
  assert.doesNotMatch(app, /window\.setTimeout\(\(\) => connectTwitchIrc\(target, \{ silent: true \}\), 150\)/);
});


test('persistent Twitch chat subscriptions use the verified moderator rather than reply-bot privileges', async () => {
  const [setup, login, app] = await Promise.all([
    readFile(new URL('../server/twitch-webhook-setup.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/twitch/login.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(setup, /MODERATOR_CHAT_SCOPES = \['user:read:chat', 'user:bot'\]/);
  assert.match(setup, /condition: \{ broadcaster_user_id: broadcasterId, user_id: staff\.userId \}/);
  assert.doesNotMatch(setup, /obtainSession\(req, res, 'bot'\)/);
  assert.match(login, /chat_setup/);
  assert.match(login, /obtainSession\(req, res, 'staff'\)/);
  assert.match(login, /paim_beach_pete/);
  assert.match(login, /user:read:email user:read:chat user:bot/);
  assert.match(app, /Authorize moderator chat intake with Twitch/);
  assert.doesNotMatch(app, /if \(!moderatorLogin \|\| !chatBotSession\.connected\)/);
});

test('chat setup OAuth rejects everyone except the signed-in moderator', async t => {
  const { default: login } = await import('../api/twitch/login.js');
  const original = globalThis.fetch;
  const oldClient = process.env.TWITCH_CLIENT_ID;
  process.env.TWITCH_CLIENT_ID = 'test-client';
  let authLogin = 'viewer';
  globalThis.fetch = async () => Response.json({
    login: authLogin, client_id: 'test-client',
  });
  t.after(() => {
    globalThis.fetch = original;
    if (oldClient === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = oldClient;
  });
  const response = () => ({
    statusCode: 200, headers: {},
    setHeader(k,v) {this.headers[k] = v;},
    status(n) {this.statusCode=n;return this;},
    send(msg) {this.body=msg;return this;},
    redirect(n,u) {this.statusCode=n;this.location=u;return this;},
  });
  const req = {
    method:'GET', headers:{host:'streampulse-clean.vercel.app',cookie:'yedi_twitch_access=valid-token'},
    query:{chat_setup:'1'},
  };
  const blocked = response();
  await login(req, blocked);
  assert.equal(blocked.statusCode, 403);
  authLogin = 'paim_beach_pete';
  const moderator = response();
  await login(req, moderator);
  assert.equal(moderator.statusCode, 302);
  const url = new URL(moderator.location);
  assert.equal(url.hostname, 'id.twitch.tv');
  assert.match(url.searchParams.get('scope'), /user:read:chat/);
  assert.match(url.searchParams.get('scope'), /user:bot/);
});

test('different URL spellings of the same video are never created twice in one webhook delivery', async () => {
  const event = {
    broadcaster_user_login:'2o3a', chatter_user_login:'normal_chatter',
    message:{text:'!assr https://youtu.be/dQw4w9WgXcQ and https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
  };
  const { items } = await makeQueueItems(event);
  assert.equal(items.length, 1);
});


test('real chat URLs from Palm_Beach_Pete are parsed as viewer requests', async () => {
  const event = {
    broadcaster_user_login: '2o3a',
    chatter_user_login: 'palm_beach_pete',
    message: {
      text: 'https://www.youtube.com/watch?v=pa6tQxHaUpk https://www.youtube.com/watch?v=2sEX02P64Nc',
    },
  };
  const request = await makeQueueItems(event);
  assert.equal(request.reason, 'ready');
  assert.equal(request.items.length, 2);
  assert.deepEqual(request.items.map(item => item.requestedBy), ['palm_beach_pete', 'palm_beach_pete']);
  assert.equal((await makeQueueItems({ ...event, chatter_user_login: 'gachibot69' })).reason, 'ignored_sender');
});

test('moderator setup starts automatically after chat scopes are approved, and storage failures are visible', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /webhookAutoSetupAttemptedRef/);
  assert.match(app, /webhookHealth\.code !== 'webhook_not_subscribed'/);
  assert.match(app, /activateTwitchWebhook\(\{ automatic: true \}\)/);
  assert.match(app, /Firestore quota is exhausted/);
  assert.match(app, /receiptCode: String\(data\.receiptCode/);
});


test('chat OAuth upgrade preserves refreshed cookies and rejects requests without a moderator session', async t => {
  const { default: login } = await import('../api/twitch/login.js');
  const oldFetch = globalThis.fetch;
  const oldId = process.env.TWITCH_CLIENT_ID;
  const oldSecret = process.env.TWITCH_CLIENT_SECRET;
  process.env.TWITCH_CLIENT_ID = 'chat-consent-test-id';
  process.env.TWITCH_CLIENT_SECRET = 'chat-consent-test-secret';
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/oauth2/token')) return Response.json({
      access_token: 'new-access', refresh_token: 'new-refresh',
    });
    if (String(url).includes('/oauth2/validate')) {
      return Response.json({
        client_id: 'chat-consent-test-id', login: 'paim_beach_pete',
        user_id: '1234567', scopes: ['user:read:email'], expires_in: 3600,
      });
    }
    throw new Error('unexpected URL in test: ' + url);
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldId === undefined) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = oldSecret;
  });
  const makeRes = () => ({
    statusCode: 200, headers: {}, location: '',
    setHeader(k,v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode=code; return this; },
    send(str) { this.body=str; return this; },
    redirect(code, url) { this.statusCode=code; this.location=url; return this; },
  });
  const res = makeRes();
  await login({
    method: 'GET', query: {chat_setup:'1'},
    headers: { host: 'streampulse-clean.vercel.app', cookie: 'yedi_twitch_refresh=old-refresh' },
  },res);
  assert.equal(res.statusCode,302);
  const cookies = Array.isArray(res.headers['Set-Cookie']) ? res.headers['Set-Cookie'] : [res.headers['Set-Cookie']];
  assert.ok(cookies.some(value => value.startsWith('yedi_twitch_access=')));
  assert.ok(cookies.some(value => value.startsWith('yedi_twitch_refresh=')));
  assert.ok(cookies.some(value => value.startsWith('yedi_twitch_oauth_state=')));
  const uri = new URL(res.location);
  assert.equal(uri.searchParams.get('scope'), 'user:read:email user:read:chat user:bot');
  const blocked = makeRes();
  await login({method:'GET',query:{chat_setup:'1'},headers:{host:'streampulse-clean.vercel.app'}},blocked);
  assert.equal(blocked.statusCode,403);
});

test('moderator can authorize missing chat scopes from the visible header without opening settings', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /Twitch chat requests are not connected/);
  assert.ok(app.includes('href="/api/twitch/login?chat_setup=1"'));
  assert.match(app, /Authorize Twitch chat requests/);
});
