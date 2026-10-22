import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibilityRestoreCommands, postTikTokPlayerCommand, postYouTubePlayerCommand } from '../src/playerBridge.js';

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

test('visibility restoration keeps a paused YouTube video paused and restores its prior audio state', () => {
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: true, muted: false }), ['pauseVideo', 'unMute']);
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: true, muted: true }), ['pauseVideo', 'mute']);
});

test('visibility restoration does not send play when returning to a tab', () => {
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: false, muted: false }), ['unMute']);
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: false, muted: false }), ['unMute']);
});

test('TikTok visibility restoration honors explicit mute and pause preferences', () => {
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: true, muted: true }), ['pause', 'mute']);
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: true, muted: false }), ['pause', 'unMute']);
});
