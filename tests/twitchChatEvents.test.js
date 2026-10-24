import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatNotification, requestLikeChatMessage } from '../src/twitchChatEvents.js';

const frame = (login, text, badges = []) => ({
  metadata: { message_type: 'notification', message_id: 'delivery-1' },
  payload: {
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_login: '2o3a', chatter_user_login: login,
      message_id: login + '-1', badges: badges.map(set_id => ({ set_id, id: '1' })),
      message: { text },
    },
  },
});

test('ordinary viewer and moderator message events are both accepted', () => {
  const viewer = parseChatNotification(frame('random_viewer', 'https://youtu.be/dQw4w9WgXcQ'));
  assert.deepEqual({ login: viewer.login, role: viewer.role }, { login: 'random_viewer', role: 'viewer' });
  assert.equal(viewer.text, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(parseChatNotification(frame('paim_beach_pete', '!assr daft punk', ['moderator'])).role, 'moderator');
});

test('bot and foreign-channel events do not create requests', () => {
  assert.equal(parseChatNotification(frame('gachibot69', 'https://youtu.be/dQw4w9WgXcQ')), null);
  const other = frame('viewer', 'test');
  other.payload.event.broadcaster_user_login = 'other_channel';
  assert.equal(parseChatNotification(other), null);
  assert.equal(parseChatNotification({ metadata: { message_type: 'session_welcome' } }), null);
});

test('chat commands and plain pasted URLs are eligible without application throttling', () => {
  assert.equal(requestLikeChatMessage('!assr https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(requestLikeChatMessage('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(requestLikeChatMessage('!assr Daft Punk'), true);
  assert.equal(requestLikeChatMessage('ordinary chat'), false);
});
