import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import subscribeHandler from '../api/_lib/chat-websocket-subscribe.js';

function response() {
  return {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('authenticated WebSocket setup rejects unsupported methods and origins', async () => {
  const a = response();
  await subscribeHandler({ method: 'GET', headers: {} }, a);
  assert.equal(a.code, 405);
  const b = response();
  await subscribeHandler({
    method: 'POST',
    headers: { host: 'streampulse-clean.vercel.app', origin: 'https://attacker.example' },
    body: { sessionId: 'AValidTwitchSession0123456789' },
  }, b);
  assert.equal(b.code, 403);
  const c = response();
  await subscribeHandler({
    method: 'POST',
    headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app' },
    body: { sessionId: '!!!' },
  }, c);
  assert.equal(c.code, 400);
});

test('moderator chat fallback uses authenticated EventSub and player retains 16:9 dimensions', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /wss:\/\/eventsub\.wss\.twitch\.tv\/ws/);
  assert.match(app, /auth\?action=ws-subscribe/);
  assert.match(app, /chatBotSession\.connected/);
  assert.doesNotMatch(app, /PASS SCHMOOPIIE/);
  assert.match(app, /aspect-video h-auto max-h-none/);
  assert.match(app, /await fetch\('\/api\/public-request'/);
});


test('chat bridge exposes failed subscription stages and last received request', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /lastMessageAt: 0/);
  assert.match(app, /lastRequestAt: 0/);
  assert.match(app, /lastRequestResult: 'received_from_twitch'/);
  assert.match(app, /twitch_chat_permission_denied|Twitch chat WebSocket subscription failed/);
  assert.match(app, /lastRequestResult: 'confirmed_in_shared_queue'/);
  assert.match(app, /lastRequestResult: 'confirmed_by_moderator_backup'/);
});


test('normal Twitch chatters can request media even when the cloud webhook health flag is stale', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /event\.chatter_is_moderator \? 'moderator' : 'viewer'/);
  assert.match(app, /handleIncomingChatCommandRef\.current\?\.\(login, role, text\)/);
  assert.doesNotMatch(app, /!text \|\| cloudChatListenerReadyRef\.current/);
});
