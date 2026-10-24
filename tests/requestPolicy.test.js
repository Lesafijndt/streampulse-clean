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
import { getInboxRetryState, isEventSubChatCandidate, versionUpdate } from '../api/_lib/cloud-chat-requests.js';
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

test('watched videos are immediately requestable regardless of playback timestamp', () => {
  assert.equal(MEDIA_HISTORY_COOLDOWN_MS, 0);
  for (const video of [
    { status: 'watched', watchedAt: new Date(NOW).toISOString() },
    { status: 'watched', playedAt: NOW },
    { status: 'watched' },
    { status: 'watched', timestamp: NOW - 1000 },
  ]) {
    assert.equal(isMediaHistoryCooldownExpired(video, NOW), true);
    assert.equal(getMediaHistoryCooldownRemainingMs(video, NOW), 0);
  }
  for (const status of ['queue', 'playing', 'watch_later']) {
    assert.equal(isMediaHistoryCooldownExpired({ status }, NOW), false);
  }
});

test('EventSub inbox retries use exponential backoff and stop after five failures', () => {
  assert.deepEqual(getInboxRetryState(1, NOW), {
    status: 'pending', retryAt: NOW + 30_000, failedAt: null,
  });
  assert.deepEqual(getInboxRetryState(2, NOW), {
    status: 'pending', retryAt: NOW + 60_000, failedAt: null,
  });
  assert.deepEqual(getInboxRetryState(5, NOW), {
    status: 'failed', retryAt: null, failedAt: NOW,
  });
});


test('successful server queue mutations refresh the write heartbeat and preserve webhook health', () => {
  const existing = {
    queueVersion: 7,
    chatIntakeHealth: {
      lastWebhookAt: NOW - 500,
      lastWriteAt: NOW - 1000,
      lastProcessingError: 'a prior failed request',
    },
  };
  const update = versionUpdate(existing, NOW);
  assert.equal(update.queueVersion, 8);
  assert.equal(update.queueUpdatedAt, NOW);
  assert.equal(update.chatIntakeHealth.lastWriteAt, NOW);
  assert.equal(update.chatIntakeHealth.lastWriteStatus, 'ok');
  assert.equal(update.chatIntakeHealth.lastWriteSource, 'eventsub');
  assert.equal(update.chatIntakeHealth.lastWebhookAt, NOW - 500);
  assert.equal(update.chatIntakeHealth.lastProcessingError, null);
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
  assert.equal(isEventSubChatCandidate(makeEvent('!assr dQw4w9WgXcQ')), true);
  assert.equal(isEventSubChatCandidate(makeEvent('', {
    message: { text: '', fragments: [{ text: 'https://youtu.be/dQw4w9WgXcQ' }] },
  })), true);
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
