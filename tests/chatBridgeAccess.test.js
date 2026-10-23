import test from 'node:test';
import assert from 'node:assert/strict';
import { canHostLocalChatBridge } from '../src/chatBridgeAccess.js';

test('the authenticated moderator may host the local Twitch request bridge', () => {
  assert.equal(canHostLocalChatBridge({
    authenticated: true,
    role: 'moderator',
    username: 'paim_beach_pete',
  }), true);
});

test('the streamer does not host the local fallback bridge', () => {
  assert.equal(canHostLocalChatBridge({
    authenticated: true,
    role: 'streamer',
    username: '2o3a',
  }), false);
});

test('regular viewers and unauthenticated sessions cannot host the bridge', () => {
  assert.equal(canHostLocalChatBridge({
    authenticated: true,
    role: 'viewer',
    username: 'someviewer',
  }), false);
  assert.equal(canHostLocalChatBridge({
    authenticated: false,
    role: 'moderator',
    username: 'paim_beach_pete',
  }), false);
  assert.equal(canHostLocalChatBridge({
    authenticated: true,
    role: 'moderator',
    username: 'anotheraccount',
  }), false);
});
