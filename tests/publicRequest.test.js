import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/_lib/public-request-handler.js';

function makeResponse() {
  return {
    code: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('public request endpoint only accepts POST and does not cache request results', async () => {
  const res = makeResponse();
  await handler({ method: 'GET', headers: {}, body: {} }, res);
  assert.equal(res.code, 405);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(res.body.code, 'method_not_allowed');
});

test('public request endpoint rejects cross-origin submissions', async () => {
  const res = makeResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://attacker.example', host: 'streampulse-clean.vercel.app', 'x-forwarded-proto': 'https' },
    body: { url: 'https://youtu.be/dQw4w9WgXcQ' },
  }, res);
  assert.equal(res.code, 403);
  assert.equal(res.body.code, 'origin_not_allowed');
});

test('public request endpoint validates a supported media URL before touching Firebase', async () => {
  const res = makeResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://streampulse-clean.vercel.app', host: 'streampulse-clean.vercel.app', 'x-forwarded-proto': 'https' },
    body: { url: 'https://example.com/not-a-video', requestedBy: 'viewer' },
  }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'unsupported_media_url');
});

test('public request endpoint rejects out-of-range timestamps without writing the queue', async () => {
  const res = makeResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://streampulse-clean.vercel.app', host: 'streampulse-clean.vercel.app', 'x-forwarded-proto': 'https' },
    body: { url: 'https://youtu.be/dQw4w9WgXcQ', requestedBy: 'viewer', startSeconds: 90000 },
  }, res);
  assert.equal(res.code, 400);
  assert.equal(res.body.code, 'invalid_start_time');
});

test('the dashboard exposes a request button, fullscreen, muted YouTube autoplay and a visible start fallback', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /Request Video/);
  assert.match(app, /fetch\('\/api\/public-request'/);
  assert.match(app, /requestFullscreen\(\)/);
  assert.match(app, /fullscreenchange/);
  assert.match(app, /const youtubePlayerSrc = useMemo/);
  assert.match(app, /const initialMute = getPlaybackIntentForVideo\(currentVideo\.id, 'youtube'\)\.muted === true/);
  assert.match(app, /if \(intent\.muted !== true\) send\('unMute'\)/);
  assert.match(app, /Click to start video/);
});


test('valid queue additions require an approved dashboard session before Firebase is touched', async () => {
  const res = makeResponse();
  await handler({
    method: 'POST',
    headers: { origin: 'https://streampulse-clean.vercel.app', host: 'streampulse-clean.vercel.app', 'x-forwarded-proto': 'https' },
    body: { url: 'https://youtu.be/dQw4w9WgXcQ', requestedBy: 'viewer' },
  }, res);
  assert.equal(res.code, 401);
  assert.equal(res.body.code, 'staff_session_required');
});

test('queue additions use the server path and cloud chat setup is moderator-operable', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const setup = await readFile(new URL('../api/twitch/eventsub-setup.js', import.meta.url), 'utf8');
  assert.match(app, /twitch-chat-bridge/);
  assert.match(app, /refreshCloudChatListener\(canConfigureCloudChat\)/);
  assert.doesNotMatch(setup, /streamer_required/);
  assert.match(setup, /moderator status for the chatting bot/);
});
