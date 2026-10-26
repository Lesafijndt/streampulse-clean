import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.WHALE_CUM_TEST_BASE_URL || 'http://127.0.0.1:5173';
const chromePath = process.env.CHROME_EXECUTABLE_PATH || 'google-chrome';

function renderInChrome(url, viewport = '1365,900') {
  const profileRoot = fileURLToPath(new URL('../../node_modules/.cache/browser-tests/', import.meta.url));
  mkdirSync(profileRoot, { recursive: true });
  const profile = mkdtempSync(profileRoot + 'profile-');
  const result = spawnSync(chromePath, [
    '--user-data-dir=' + profile,
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--window-size=' + viewport, '--virtual-time-budget=8000',
    '--dump-dom', url
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Headless Chrome exited unsuccessfully: ' + (result.stderr || '').slice(-2500));
  return result.stdout || '';
}

test('Vite serves the dashboard and successfully transforms the main React module', async () => {
  const home = await fetch(baseUrl, { cache: 'no-store' });
  assert.equal(home.status, 200, 'dashboard HTML should load');
  const homeHtml = await home.text();
  assert.match(homeHtml, /id="root"/i, 'dashboard HTML must contain its React mount point');

  const moduleResponse = await fetch(baseUrl + '/src/App.tsx', { cache: 'no-store' });
  const moduleText = await moduleResponse.text();
  assert.equal(moduleResponse.status, 200, 'main React module should compile: ' + moduleText.slice(0, 2500));
  assert.doesNotMatch(moduleText, /Internal Server Error|Failed to resolve import/i, 'Vite should not return a transform error');
});

test('provider command bridge sends correctly shaped YouTube and TikTok messages in a browser', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/player-bridge.html?autotest=1');
  assert.match(html, /data-test-status="pass"/, 'YouTube and TikTok browser command assertions should pass; output: ' + html.slice(-3500));
  assert.doesNotMatch(html, /data-test-status="fail"/, 'provider command assertions failed');
});

test('actual streamer dashboard imports its queue and persists Next through the private Postgres transport', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/postgres-dashboard.html');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-2000));
  assert.doesNotMatch(html, /data-test-status="fail"/);
});

test('an authoritative empty Postgres queue is not repopulated from stale browser cache', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/postgres-dashboard.html?cleared=1');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-2000));
});

test('actual Twitch React player autoplays, retains audio, waits while paused, and advances only once on playback completion', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/twitch-player.html');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('dashboard fullscreen fallback and confirmed queue reset preserve the playing item', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/postgres-dashboard.html?reset=1');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('P and Left Arrow replay history after the queue ends and persist the replay', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/postgres-dashboard.html?previous=1');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

for (const provider of ['tiktok', 'youtube']) test(provider + ' actual dashboard preserves paused position across remount and autoplays new request generations', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/playback-dashboard.html?provider=' + provider);
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

for (const provider of ['tiktok', 'youtube']) for (const scenario of ['ended', 'boundary', 'paused', 'stopped']) {
  test(provider + ' dashboard completion ' + scenario + ' persists one transition and autoplays next', () => {
    const html = renderInChrome(baseUrl + '/tests/browser/completion-dashboard.html?provider=' + provider + '&scenario=' + scenario);
    assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
  });
}

for (const role of ['streamer', 'moderator']) test(role + ' dashboard consumes verified webhook feed exactly once with isolated audio/replies', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/command-dashboard.html?role=' + role);
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('actual dashboard enriches a playing placeholder title through the metadata store operation', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/metadata-playback-dashboard.html?provider=youtube');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('metadata generation changes during a lookup release pending state and retry the playing request', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/metadata-generation-dashboard.html?provider=youtube');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('header shuffle persists one atomic operation and preserves playback through success and conflict', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/shuffle-playback-dashboard.html?provider=youtube');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('public /queue App route never starts staff authentication or private storage', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/public-queue-route.html');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});

test('streamer webhook volume reaches native Twitch playback', () => {
  const html = renderInChrome(baseUrl + '/tests/browser/command-dashboard.html?provider=twitch');
  assert.ok(/data-test-status="pass"/.test(html), html.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || html.slice(-3500));
});
