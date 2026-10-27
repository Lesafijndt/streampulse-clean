import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const fixture = {
  playing: { id: 'live', position: 0, title: 'Playing title', platform: 'youtube', durationSec: 90, requestedBy: 'Alice' },
  queue: [{ id: 'second', position: 2, title: 'Second title', platform: 'twitch', durationSec: 120, requestedBy: 'Bob' }, { id: 'first', position: 1, title: 'First title', platform: 'youtube', durationSec: 60, requestedBy: 'Carol' }],
  updatedAt: 123
};

test('public queue loads without auth, polls only visible pages, retains data after errors and cleans up', async () => {
  const states = [];
  const effects = [];
  let index = 0;
  let interval;
  let listener;
  let cleared = false;
  let requests = 0;
  let fail = false;
  const document = { hidden: false, addEventListener: (name, callback) => { listener = callback; }, removeEventListener: () => { listener = null; } };
  const window = { setInterval: (callback, delay) => { assert.equal(delay, 30000); interval = callback; return 1; }, clearInterval: () => { cleared = true; } };
  const fetch = async (url, options) => {
    requests += 1;
    assert.equal(url, '/api/twitch/session?action=queue-view');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers, undefined);
    return { ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { error: 'Temporarily unavailable' } : fixture };
  };
  const hooks = {
    ...require('react'),
    useState: (initial) => { const slot = index++; if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial; return [states[slot], (value) => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }]; },
    useEffect: (effect) => { effects.push(effect); }
  };
  const source = fs.readFileSync(new URL('../src/components/PublicQueue.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => name === 'react' ? hooks : name === '../queueLogic.js' ? { formatMediaDuration: (seconds) => `${seconds}s` } : require(name);
  new Function('require', 'module', 'exports', 'document', 'window', 'fetch', 'location', code)(localRequire, module, module.exports, document, window, fetch, {search:''});
  const render = () => { index = 0; return module.exports.default(); };
  render();
  const cleanup = effects[0]();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.deepEqual(states[0], fixture);
  const tree = JSON.stringify(render());
  assert.ok(tree.includes('Playing title'));
  assert.ok(tree.indexOf('First title') < tree.indexOf('Second title'));
  assert.equal(tree.includes('iframe'), false);
  states[3] = 'Bob';
  const searched = JSON.stringify(render());
  assert.ok(searched.includes('Second title'));
  assert.equal(searched.includes('First title'), false);
  states[3] = ''; states[4] = '@bOb';
  const owned = JSON.stringify(render());
  assert.ok(owned.includes('Second title'));
  assert.equal(owned.includes('First title'), false);
  assert.ok(owned.includes('Position 2'));
  document.hidden = true;
  listener();
  interval();
  await settle();
  assert.equal(requests, 1);
  document.hidden = false;
  listener();
  await settle();
  assert.equal(requests, 2);
  fail = true;
  interval();
  await settle();
  assert.equal(states[1], 'Temporarily unavailable');
  assert.deepEqual(states[0], fixture);
  cleanup();
  assert.equal(cleared, true);
  assert.equal(listener, null);
});
