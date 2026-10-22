import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  MEDIA_HISTORY_COOLDOWN_MS,
  getMediaHistoryCooldownRemainingMs,
  isMediaHistoryCooldownExpired,
  parseMediaStartSeconds,
  stripMediaTimestampSuffix,
} from '../src/mediaUtils.js';
import { isEventSubChatCandidate } from '../api/_lib/cloud-chat-requests.js';
import { isValidEventSubSignature } from '../api/twitch/eventsub.js';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');

test('parses YouTube start offsets in seconds, colon time, and h/m/s syntax', () => {
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk?t=83'), 83);
  assert.equal(parseMediaStartSeconds('https://youtube.com/watch?v=abcdefghijk&start=90'), 90);
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk#t=1m23s'), 83);
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk 1:23'), 83);
  assert.equal(parseMediaStartSeconds('!assr https://youtu.be/abcdefghijk 1:02:03'), 3723);
  assert.equal(parseMediaStartSeconds('!assr Daft Punk - One More Time 1:23'), 83);
  assert.equal(parseMediaStartSeconds('!assr Daft Punk - One More Time at 90s'), 90);
  assert.deepEqual(stripMediaTimestampSuffix('!assr Daft Punk - One More Time 1:23'), {
    text: 'Daft Punk - One More Time', startSeconds: 83,
  });
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk?t=90s'), 90);
});

test('does not mistake title text or invalid offsets for a playback position', () => {
  assert.equal(parseMediaStartSeconds('a funny video about 1 dog'), 0);
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk?t=999999'), 0);
  assert.equal(parseMediaStartSeconds('https://youtu.be/abcdefghijk'), 0);
});

test('history item becomes requestable exactly 16 hours after watchedAt', () => {
  const item = { status: 'watched', watchedAt: new Date(NOW - MEDIA_HISTORY_COOLDOWN_MS).toISOString() };
  assert.equal(isMediaHistoryCooldownExpired(item, NOW), true);
  assert.equal(getMediaHistoryCooldownRemainingMs(item, NOW), 0);
});

test('history cooldown does not expire early and active entries never qualify', () => {
  const recent = { status: 'watched', watchedAt: new Date(NOW - MEDIA_HISTORY_COOLDOWN_MS + 1000).toISOString() };
  assert.equal(isMediaHistoryCooldownExpired(recent, NOW), false);
  assert.equal(getMediaHistoryCooldownRemainingMs(recent, NOW), 1000);
  assert.equal(isMediaHistoryCooldownExpired({ status: 'queue', watchedAt: new Date(NOW - MEDIA_HISTORY_COOLDOWN_MS * 2).toISOString() }, NOW), false);
  assert.equal(isMediaHistoryCooldownExpired({ status: 'watched' }, NOW), false);
});


test('EventSub API candidate filter accepts media requests and supported queue commands only', () => {
  const makeEvent = (text, overrides = {}) => ({
    broadcaster_user_login: '2o3a',
    broadcaster_user_id: '123',
    chatter_user_login: 'someviewer',
    chatter_user_id: '456',
    message: { text },
    ...overrides,
  });
  assert.equal(isEventSubChatCandidate(makeEvent('!assr Daft Punk 1:23')), true);
  assert.equal(isEventSubChatCandidate(makeEvent('here is one https://youtu.be/abcdefghijk')), true);
  assert.equal(isEventSubChatCandidate(makeEvent('!queue')), true);
  assert.equal(isEventSubChatCandidate(makeEvent('!bigcock 2')), true);
  assert.equal(isEventSubChatCandidate(makeEvent('!skip', { chatter_is_moderator: true })), true);
  assert.equal(isEventSubChatCandidate(makeEvent('hello chat')), false);
  assert.equal(isEventSubChatCandidate(makeEvent('!volume up')), false);
  assert.equal(isEventSubChatCandidate(makeEvent('!queue', { broadcaster_user_login: 'different_channel' })), false);
  assert.equal(isEventSubChatCandidate(makeEvent('!queue', { chatter_user_login: 'nightbot' })), false);
});


test('EventSub webhook signature verifies raw payload and rejects tampering/stale timestamps', () => {
  const secret = 'a-test-only-webhook-secret';
  const messageId = 'message-123';
  const timestamp = new Date().toISOString();
  const payload = Buffer.from('{"subscription":{"type":"channel.chat.message"},"event":{"message":{"text":"!queue"}}}');
  const signature = 'sha256=' + createHmac('sha256', secret)
    .update(messageId).update(timestamp).update(payload).digest('hex');
  assert.equal(isValidEventSubSignature(secret, messageId, timestamp, payload, signature), true);
  assert.equal(isValidEventSubSignature(secret, messageId, timestamp, payload, signature + 'x'), false);
  const changedPayload = Buffer.from(payload.toString('utf8') + ' ');
  assert.equal(isValidEventSubSignature(secret, messageId, timestamp, changedPayload, signature), false);
  const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const staleSignature = 'sha256=' + createHmac('sha256', secret)
    .update(messageId).update(stale).update(payload).digest('hex');
  assert.equal(isValidEventSubSignature(secret, messageId, stale, payload, staleSignature), false);
});
