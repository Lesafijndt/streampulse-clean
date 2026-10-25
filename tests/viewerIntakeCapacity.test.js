import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import webhook from '../server/twitch-webhook.js';
import { bufferRequest, consumeRequest } from '../server/durable-intake.js';
import { createDocumentStore } from '../server/postgres-store.js';
import { getQueueNamespace } from '../server/firebase-guard.js';

const namespace = getQueueNamespace(), base = `artifacts/${namespace}/public/data`;
const eventFor = i => ({ broadcaster_user_login: '2o3a', chatter_user_login: `ordinary_viewer_${i}`,
  message_id: `message-${i}`, message: { text: `hello https://youtu.be/v${String(i).padStart(10, '0')}` } });
function memoryStore() {
  let state = { version: 0, documents: {} };
  return createDocumentStore({ namespace, readState: async () => structuredClone(state),
    compareAndSwap: async (version, documents) => {
      if (state.version !== version) return false;
      state = { version: version + 1, documents: structuredClone(documents) }; return true;
    } });
}
for (const concurrency of [1, 4]) test(`100 ordinary viewers pass signed webhook, buffer and DB consumer (concurrency ${concurrency}) without an allowlist`, async t => {
  const old = process.env.TWITCH_EVENTSUB_SECRET;
  const secret = process.env.TWITCH_EVENTSUB_SECRET = 'capacity-test-webhook-secret';
  t.after(() => { if (old === undefined) delete process.env.TWITCH_EVENTSUB_SECRET; else process.env.TWITCH_EVENTSUB_SECRET = old; });
  const db = memoryStore(), payloads = [];
  async function deliver(event, id) {
    const timestamp = new Date().toISOString();
    const rawBody = Buffer.from(JSON.stringify({ subscription: { type: 'channel.chat.message', id: 'capacity-sub' }, event }));
    const signature = 'sha256=' + createHmac('sha256', secret).update(id).update(timestamp).update(rawBody).digest('hex');
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }, end() { return this; } };
    await webhook({ method: 'POST', rawBody, query: {}, headers: {
      'twitch-eventsub-message-id': id, 'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-signature': signature, 'twitch-eventsub-message-type': 'notification',
    } }, res, { buffer: input => bufferRequest(input, { send: async (_topic, payload) => { payloads.push(payload); } }) });
    assert.equal(res.statusCode, 204); return payloads.at(-1);
  }
  // No viewer cookie, OAuth token, staff role or allowlist is supplied.
  for (let i = 0; i < 100; i++) await deliver(eventFor(i), `signed-${i}`);
  assert.equal(payloads.length, 100);
  for (let start = 0; start < 100; start += concurrency) {
    const results = await Promise.all(payloads.slice(start, start + concurrency).map(payload => consumeRequest(payload, { db })));
    assert.ok(results.every(result => result.status === 'queued' && result.queued === 1));
  }
  const queue = db.collection(`${base}/queue_videos`), receipts = db.collection(`${base}/twitch_eventsub_receipts`);
  const rows = (await queue.get()).docs;
  assert.equal(rows.length, 100); assert.equal(new Set(rows.map(row => row.get('url'))).size, 100);
  assert.deepEqual(rows.map(row => row.get('requestedBy')).sort(), Array.from({ length: 100 }, (_, i) => `ordinary_viewer_${i}`).sort());
  assert.ok(rows.every(row => row.get('userRole') === 'viewer' && row.get('status') === 'queue'));
  assert.equal((await receipts.get()).size, 100);
  assert.equal((await consumeRequest(payloads[0], { db })).status, 'duplicate_delivery');
  const duplicate = await deliver({ ...eventFor(0), message_id: 'duplicate' }, 'duplicate');
  assert.equal((await consumeRequest(duplicate, { db })).status, 'duplicate_media');
  const original = rows.find(row => row.get('requestedBy') === 'ordinary_viewer_0');
  await original.ref.update({ status: 'watched', playedAt: 12345, retainedVotes: ['alice'] });
  const replay = await deliver({ ...eventFor(0), chatter_user_login: 'another_ordinary_viewer', message_id: 'replay' }, 'replay');
  assert.equal((await consumeRequest(replay, { db })).status, 'queued');
  const history = (await queue.get()).docs.filter(row => row.id.startsWith('history-'));
  assert.equal(history.length, 1); assert.equal(history[0].get('playedAt'), 12345);
  assert.deepEqual(history[0].get('retainedVotes'), ['alice']);
  assert.equal((await original.ref.get()).get('requestedBy'), 'another_ordinary_viewer');
  const bot = await deliver({ ...eventFor(101), chatter_user_login: 'GachiBot69' }, 'bot');
  assert.equal((await consumeRequest(bot, { db })).status, 'ignored_sender');
  assert.equal((await queue.get()).size, 101); assert.equal((await receipts.get()).size, 102);
  await assert.rejects(consumeRequest({ ...payloads[0], event: eventFor(999) }, { db }), /invalid_queue_signature/);
});
