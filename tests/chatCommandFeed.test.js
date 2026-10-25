import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeChatCommandFeed as consume } from '../src/chatCommandFeed.js';
const packet = { id: 'one', at: 1000, volumeCommand: { action: 'set', value: 25 }, reply: 'Queue status.' };
function context(overrides = {}) {
  const stored = new Map(), calls = [], errors = [];
  return { login: '2o3a', authenticated: true, loaded: true, connected: true, now: 1000, seen: new Set(),
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    claim: async (id, kind) => { calls.push([id, kind]); return true; },
    audio: value => calls.push(value), reply: value => calls.push(value), error: value => errors.push(value),
    calls, errors, stored, ...overrides };
}
test('claim failures remain retryable and do not persist completion', async () => {
  let fails = true; const ctx = context({ claim: async () => { if (fails) throw Error('Database unavailable'); return true; } });
  await consume([packet], ctx);
  assert.equal(ctx.errors.length, 1); assert.equal(ctx.seen.size, 0); assert.equal(ctx.stored.size, 0); assert.equal(ctx.calls.length, 0);
  fails = false; await consume([packet], ctx); await consume([packet], ctx);
  assert.deepEqual(ctx.calls, [packet.volumeCommand]);
});
test('durable losing claim suppresses action even with fresh browser storage', async () => {
  const ctx = context({ claim: async () => false }); await consume([packet], ctx);
  assert.equal(ctx.calls.length, 0); assert.equal(ctx.stored.size, 1);
});
test('only connected moderator sends explicit replies; URL/assr intake packets stay silent', async () => {
  for (const overrides of [{ login: 'viewer' }, { login: 'paim_beach_pete', connected: false }, { authenticated: false }, { loaded: false }]) {
    const ctx = context(overrides); await consume([packet], ctx); assert.equal(ctx.calls.length, 0);
  }
  const ctx = context({ login: 'paim_beach_pete' });
  await consume([{ id: 'url', at: 1000 }, { id: 'assr', at: 1000 }, packet, { ...packet, id: 'stale', at: -120000 }], ctx);
  assert.deepEqual(ctx.calls, [['one', 'reply'], 'Queue status.']);
});

test('overlapping snapshots preserve command order while claims are in flight', async () => {
  let release;const applied=[];
  const ctx=context({claim:async id=>{if(id==='first')await new Promise(resolve=>{release=resolve});return true},audio:value=>applied.push(value.value)});
  const first={id:'first',at:1000,volumeCommand:{action:'set',value:10}};
  const second={id:'second',at:1000,volumeCommand:{action:'set',value:50}};
  const a=consume([first],ctx);const b=consume([first,second],ctx);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(applied,[]);release();
  await Promise.all([a,b]);assert.deepEqual(applied,[10,50]);
});
