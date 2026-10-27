import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackFailureMessage, prepareNextConnections, queueHealthWarnings } from '../src/playbackReliability.js';

test('restriction messages distinguish reported facts from possible age or regional restrictions', () => {
  assert.match(playbackFailureMessage('youtube', 100), /removed or is private/);
  for (const code of [101, 150]) assert.match(playbackFailureMessage('youtube', code), /age, sign-in, or regional/);
  assert.match(playbackFailureMessage('youtube', 153), /verify this site/);
  for (const platform of ['twitch', 'tiktok', 'instagram']) assert.match(playbackFailureMessage(platform), /age-restricted/);
});

test('preloading only creates allowlisted connections and cleans them on next-item changes', () => {
  const links = [];
  const document = { createElement: tag => ({ tag, dataset: {}, remove() { links.splice(links.indexOf(this), 1); } }), head: { appendChild: link => links.push(link) } };
  const cleanup = prepareNextConnections({platform:'youtube',url:'https://evil.example'},document);
  assert.deepEqual(links.map(link => link.href), ['https://www.youtube.com','https://i.ytimg.com']);
  assert.ok(links.every(link => link.tag === 'link' && link.rel === 'preconnect'));
  cleanup(); assert.equal(links.length,0);
  prepareNextConnections({platform:'evil'},document)(); assert.equal(links.length,0);
});

test('health flags broken intake/storage but never treats quiet chat or valid duplicates as a failed save', () => {
  const good = {active:true,receiptCode:'ok',lastWebhookAt:1000,lastQueueWriteAt:1000,lastWebhookResult:'queued'};
  assert.deepEqual(queueHealthWarnings(good,{now:2000}),[]);
  assert.deepEqual(queueHealthWarnings({...good,lastWebhookResult:'duplicate_media'},{now:2000}),[]);
  assert.match(queueHealthWarnings(good,{now:1900000})[0],/alone does not prove a fault/);
  assert.ok(queueHealthWarnings({...good,active:false,receiptCode:'storage_unavailable',lastWebhookResult:'buffered'},{online:false}).length>=3);
  assert.deepEqual(queueHealthWarnings({loading:true}),[]);
});
