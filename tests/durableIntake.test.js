import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferRequest, consumeRequest, retryDelay } from '../server/durable-intake.js';
import webhook from '../server/twitch-webhook.js';
import setup from '../server/twitch-webhook-setup.js';
import { createHmac } from 'node:crypto';

const event = { broadcaster_user_login: '2o3a', chatter_user_login: 'any_viewer',
  message: { text: 'https://www.youtube.com/watch?v=pa6tQxHaUpk' } };
function environment(t) {
  const old = { ...process.env };
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  process.env.TWITCH_EVENTSUB_SECRET = 'a-secure-test-webhook-secret';
  t.after(() => { for (const key of ['TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','TWITCH_EVENTSUB_SECRET']) {
    if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  } });
}
function response() { return { statusCode: 200, setHeader() {}, getHeader() {},
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; }, end() { return this; } }; }
test('request is durably buffered independently of Firestore; quota failures cannot acknowledge it', async t => {
  environment(t); let captured;
  await bufferRequest({ event, messageId: 'message-123', subscriptionId: 'sub-1' }, {
    send: async (topic, payload, options) => { captured = { topic, payload, options }; },
  });
  assert.equal(captured.options.retentionSeconds, 604800);
  assert.equal(captured.options.idempotencyKey, 'chat-message-123');
  const quota = Object.assign(new Error('RESOURCE_EXHAUSTED'), { code: 8 });
  await assert.rejects(consumeRequest(captured.payload, { lookupMetadata: null, db: {
    collection() { throw quota; },
  } }), error => error === quota);
  assert.deepEqual(retryDelay(quota, { deliveryCount: 100 }), { afterSeconds: 900 });
  assert.deepEqual(retryDelay(new Error('network'), { deliveryCount: 2 }), { afterSeconds: 60 });
  await assert.rejects(consumeRequest({ ...captured.payload, event: { ...event, chatter_user_login: 'attacker' } }), /invalid_queue_signature/);
});
test('signed webhook acknowledges buffer success and returns failure if the buffer is unavailable', async t => {
  environment(t);
  const timestamp = new Date().toISOString(); const id = 'signed-message-123';
  const rawBody = JSON.stringify({ subscription: { type: 'channel.chat.message', id: 'sub-1' }, event });
  const signature = 'sha256=' + createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET)
    .update(id).update(timestamp).update(rawBody).digest('hex');
  const request = { method: 'POST', rawBody, query: {}, headers: {
    'twitch-eventsub-message-id': id, 'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-signature': signature, 'twitch-eventsub-message-type': 'notification',
  } };
  const ok = response(); let saved;
  await webhook(request, ok, { buffer: async input => { saved = input; return { buffered: true }; } });
  assert.equal(ok.statusCode, 204); assert.equal(saved.event.chatter_user_login, 'any_viewer');
  const failed = response();
  await webhook(request, failed, { buffer: async () => { throw Error('transport unavailable'); } });
  assert.equal(failed.statusCode, 503);
  const forged = response();
  await webhook({ ...request, rawBody: '{}' }, forged, { buffer: async () => assert.fail('untrusted request reached buffer') });
  assert.equal(forged.statusCode, 403);
});
test('enabled moderator webhook is visible even when the current login token has only email scope', async t => {
  environment(t); const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async url => {
    if (url.includes('/validate')) return Response.json({ client_id: 'test-client', login: 'paim_beach_pete', user_id: '448963786', scopes: ['user:read:email'] });
    if (url.includes('/oauth2/token')) return Response.json({ access_token: 'app-token' });
    if (url.includes('/helix/users')) return Response.json({ data: [{ id: '92111909' }] });
    if (url.includes('/subscriptions')) return Response.json({ data: [{ type: 'channel.chat.message', status: 'enabled',
      condition: { broadcaster_user_id: '92111909', user_id: '448963786' },
      transport: { method: 'webhook', callback: 'https://streampulse-clean.vercel.app/api/twitch/bot-session?action=webhook' } }] });
    throw Error('unexpected request');
  };
  const res = response();
  await setup({ method: 'GET', headers: { cookie: 'yedi_twitch_access=valid', host: 'streampulse-clean.vercel.app' } }, res, {
    statusOnly: true, readReceipt: async () => ({ receiptCode: 'firestore_quota_exceeded' }),
  });
  assert.equal(res.statusCode, 200); assert.equal(res.body.active, true); assert.equal(res.body.code, 'webhook_existing');
  assert.equal(res.body.receiptCode, 'firestore_quota_exceeded');
});
