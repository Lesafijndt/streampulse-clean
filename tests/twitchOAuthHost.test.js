import test from 'node:test';
import assert from 'node:assert/strict';
import authHandler from '../api/twitch/auth.js';

function response() {
  const headers = new Map();
  return {
    headers, statusCode: 200, redirectUrl: '',
    setHeader(key, value) { headers.set(key, value); },
    getHeader(key) { return headers.get(key); },
    status(code) { this.statusCode = code; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('preview-host staff and bot login redirect to canonical host before issuing state', (t) => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_REDIRECT_URI = 'https://streampulse-clean.vercel.app/api/twitch/callback';
  process.env.TWITCH_APP_URL = 'https://streampulse-clean.vercel.app';
  for (const [action, endpoint] of [['login', 'login'], ['bot-login', 'bot-login']]) {
    const res = response();
    authHandler({ method: 'GET', query: { action }, headers: {
      host: 'streampulse-clean-git-feature.example.vercel.app',
      'x-forwarded-proto': 'https',
    } }, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectUrl, 'https://streampulse-clean.vercel.app/api/twitch/' + endpoint);
    assert.equal(res.getHeader('Set-Cookie'), undefined);
  }
});

test('canonical-host staff login issues Secure SameSite=Lax state cookie and aligned callback', (t) => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.TWITCH_CLIENT_ID = 'test-client';
  process.env.TWITCH_REDIRECT_URI = 'https://streampulse-clean.vercel.app/api/twitch/callback';
  const res = response();
  authHandler({ method: 'GET', query: { action: 'login' }, headers: {
    host: 'streampulse-clean.vercel.app',
    'x-forwarded-proto': 'https',
  } }, res);
  assert.equal(res.statusCode, 302);
  assert.match(res.redirectUrl, /^https:\/\/id\.twitch\.tv\/oauth2\/authorize\?/);
  const target = new URL(res.redirectUrl);
  assert.equal(target.searchParams.get('redirect_uri'), process.env.TWITCH_REDIRECT_URI);
  assert.ok(target.searchParams.get('state'));
  assert.match(res.getHeader('Set-Cookie'), /SameSite=Lax; Max-Age=600; Secure/);
  assert.ok(res.getHeader('Set-Cookie').includes(target.searchParams.get('state')));
});
