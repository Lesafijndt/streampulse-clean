import test from 'node:test';
import assert from 'node:assert/strict';
import { canHostLocalChatBridge, hasVerifiedCloudChatIntake } from '../src/chatBridgeAccess.js';

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


test('enabled EventSub does not silence IRC until a webhook has actually processed', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const base = {
    active: true, firestoreStatus: 'connected',
    lastWebhookStatus: 'persisted', lastProcessingStatus: 'ok',
    lastWebhookAt: now - 1000,
  };
  assert.equal(hasVerifiedCloudChatIntake({ ...base, lastWebhookAt: 0 }, now), false);
  assert.equal(hasVerifiedCloudChatIntake({ ...base, lastProcessingStatus: 'pending' }, now), false);
  assert.equal(hasVerifiedCloudChatIntake({ ...base, firestoreStatus: 'unavailable' }, now), false);
  assert.equal(hasVerifiedCloudChatIntake(base, now), true);
  assert.equal(hasVerifiedCloudChatIntake({ ...base, lastWebhookAt: now - 11 * 60_000 }, now), false);
});
