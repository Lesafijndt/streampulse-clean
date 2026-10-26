import { createHmac, timingSafeEqual } from 'node:crypto';
import { extractChatRequests, getEventText, persistChatEvent } from './webhook-queue.js';
import { getVerifiedFirestore } from './firebase-guard.js';
import { parseServerCommand, persistChatCommand } from './chat-commands.js';
import { lookupQueueMetadata } from './queue-metadata.js';

export const TOPIC = 'twitch-viewer-requests-v2';
export const REGION = 'iad1';
const RETENTION = 7 * 24 * 3600;
let client;
function signature(payload) {
  if (!process.env.TWITCH_EVENTSUB_SECRET) throw new Error('webhook_secret_missing');
  return createHmac('sha256', process.env.TWITCH_EVENTSUB_SECRET).update(JSON.stringify({
    version: payload.version, kind: payload.kind, event: payload.event,
    messageId: payload.messageId, subscriptionId: payload.subscriptionId,
    receivedAt: payload.receivedAt, producer: payload.producer,
  })).digest('hex');
}
export function isRequestEvent(event) {
  if (String(event?.broadcaster_user_login || '').toLowerCase() !== '2o3a') return false;
  const request = extractChatRequests(getEventText(event));
  return request.links.length > 0 || Boolean(request.titleQuery) || Boolean(parseServerCommand(event));
}
export async function bufferRequest({ event, messageId, subscriptionId, kind = 'chat' }, dependencies = {}) {
  if (kind !== 'health' && !isRequestEvent(event)) return { ignored: true };
  const payload = { version: 1, kind, event, messageId, subscriptionId,
    receivedAt: Date.now(), producer: process.env.VERCEL_DEPLOYMENT_ID || 'local' };
  payload.signature = signature(payload);
  const send = dependencies.send || (await (client ||= import('@vercel/queue').then(({ QueueClient }) => new QueueClient({ region: REGION })))).send;
  await send(TOPIC, payload, { retentionSeconds: RETENTION,
    idempotencyKey: 'chat-' + String(messageId).slice(0, 180) });
  return { buffered: true };
}
export async function consumeRequest(payload, dependencies = {}) {
  const supplied = Buffer.from(String(payload?.signature || ''));
  const expected = Buffer.from(signature(payload || {}));
  if (payload?.version !== 1 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('invalid_queue_signature');
  }
  if (payload.kind === 'health') {
    if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
      const { getQueueNamespace } = await import('./firebase-guard.js');
      const db = dependencies.db || await getVerifiedFirestore();
      await db.doc(`artifacts/${getQueueNamespace()}/public/data/system_diagnostics/queue-${payload.messageId}`).set({
        producer: payload.producer, consumer: process.env.VERCEL_DEPLOYMENT_ID || 'local', storedAt: Date.now(),
      });
    }
    console.info('twitch_intake_transport_verified', { producer: payload.producer,
      consumer: process.env.VERCEL_DEPLOYMENT_ID || 'local', probeId: payload.messageId });
    return { transportVerified: true };
  }
  if (!isRequestEvent(payload.event)) throw new Error('invalid_request_event');
  try {
    const db = dependencies.db || await getVerifiedFirestore();
    // A quota/network failure MUST throw. Returning would acknowledge and lose it.
    if (parseServerCommand(payload.event)) {
      const result = await persistChatCommand(db, { ...payload, expiresAt: Number(payload.receivedAt || 0) + 120000 }, { sendReply: dependencies.sendReply });
      console.info('twitch_chat_command', { status: result.status, command: result.command, duplicate: result.duplicate === true, replyDelivery: result.replyDelivery || 'none' });
      return result;
    }
    return await persistChatEvent(db, payload, { lookupMetadata: dependencies.lookupMetadata === undefined ? lookupQueueMetadata : dependencies.lookupMetadata });
  } catch (error) {
    console.warn('twitch_intake_retry', { code: String(error?.code || 'storage_unavailable').slice(0, 60) });
    throw error;
  }
}
export function retryDelay(error, metadata = {}) {
  const quota = /RESOURCE_EXHAUSTED|quota|\b8\b/i.test(String(error?.code || '') + ' ' + String(error?.message || ''));
  return { afterSeconds: quota ? 900 : Math.min(900, 30 * 2 ** Math.min(5, Math.max(0, (metadata.deliveryCount || 1) - 1))) };
}
