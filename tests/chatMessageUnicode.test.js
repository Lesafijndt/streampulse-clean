import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/twitch/chat-message.js';

test('dashboard fallback sends a complete 450-codepoint reply and rejects oversize without truncating', async t => {
  const saved = { id: process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET, origin: process.env.TWITCH_APP_URL, fetch: global.fetch };
  t.after(() => {
    for (const [key, value] of [['TWITCH_CLIENT_ID', saved.id], ['TWITCH_CLIENT_SECRET', saved.secret], ['TWITCH_APP_URL', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    global.fetch = saved.fetch;
  });
  process.env.TWITCH_CLIENT_ID = 'test-client'; process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  process.env.TWITCH_APP_URL = 'https://streampulse-clean.vercel.app';
  const sent = [];
  global.fetch = async (url, options = {}) => {
    let body;
    if (String(url).includes('/oauth2/validate')) body = options.headers.Authorization === 'OAuth staff'
      ? { client_id: 'test-client', login: 'paim_beach_pete' }
      : { client_id: 'test-client', login: 'gachibot69', user_id: 'bot', scopes: ['user:write:chat'] };
    else if (String(url).includes('/helix/users')) body = { data: [{ id: 'channel' }] };
    else if (String(url).includes('/helix/chat/messages')) { sent.push(JSON.parse(options.body).message); body = { data: [{ is_sent: true }] }; }
    else throw new Error('Unexpected request');
    return { ok: true, json: async () => body };
  };
  const run = async message => {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: { host: 'streampulse-clean.vercel.app', origin: 'https://streampulse-clean.vercel.app',
      cookie: 'yedi_twitch_access=staff; yedi_twitch_bot_access=bot' }, body: { message } }, res); return res;
  };
  const message = '\u{1F600}'.repeat(450);
  assert.equal((await run(message)).code, 200); assert.deepEqual(sent, [message]);
  assert.equal((await run(message + 'x')).code, 400); assert.deepEqual(sent, [message]);
});
