import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseUrl = process.env.WHALE_CUM_TEST_BASE_URL || 'http://127.0.0.1:5173';
const chromePath = process.env.CHROME_EXECUTABLE_PATH || 'google-chrome';

function renderInChrome(url, viewport = '1365,900') {
  const result = spawnSync(chromePath, [
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
