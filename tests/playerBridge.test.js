import test from 'node:test';
import assert from 'node:assert/strict';
import { postTikTokPlayerCommand, postYouTubePlayerCommand } from '../src/playerBridge.js';

test('TikTok commands are allowlisted and target the official embed origin', () => {
  const messages = []; const target = { postMessage: (data, origin) => messages.push({ data, origin }) };
  assert.equal(postTikTokPlayerCommand(target, 'pause'), true);
  assert.equal(postTikTokPlayerCommand(target, 'mute'), true);
  assert.equal(postTikTokPlayerCommand(target, 'executeArbitraryCode'), false);
  assert.equal(messages.length, 2); assert.equal(messages[0].origin, 'https://www.tiktok.com');
  assert.deepEqual(messages[0].data, { type: 'pause', value: null, 'x-tiktok-player': true });
});

test('YouTube commands use the expected IFrame Player API message format', () => {
  const messages = []; const target = { postMessage: (data, origin) => messages.push({ data, origin }) };
  assert.equal(postYouTubePlayerCommand(target, 'playVideo'), true);
  assert.equal(postYouTubePlayerCommand(target, 'pauseVideo'), true);
  assert.equal(postYouTubePlayerCommand(target, 'unknownCommand'), false);
  assert.equal(messages.length, 2); assert.equal(messages[0].origin, 'https://www.youtube.com');
  assert.deepEqual(JSON.parse(messages[0].data), { event: 'command', func: 'playVideo', args: [] });
});
