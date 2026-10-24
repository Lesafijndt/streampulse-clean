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
  assert.match(app, /Server webhook active/);
  assert.match(app, /activateTwitchWebhook/);
  assert.doesNotMatch(app, /window\.setTimeout\(\(\) => connectTwitchIrc\(target, \{ silent: true \}\), 150\)/);
});
