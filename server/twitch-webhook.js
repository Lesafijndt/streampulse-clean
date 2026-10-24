import { createHmac, timingSafeEqual } from 'node:crypto';
import { getVerifiedFirestore } from './firebase-guard.js';
import { persistChatEvent } from './webhook-queue.js';

export async function readTwitchRawBody(req, maxBytes = 262144) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') {
    // Only useful for local test doubles. Real deployment has bodyParser=false
    // and signs the exact bytes, not reserialized JSON.
    if (typeof req[Symbol.asyncIterator] !== 'function') return Buffer.from(JSON.stringify(req.body));
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Webhook payload too large'), { code: 'webhook_too_large' });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function verifyTwitchSignature({ id, timestamp, signature, rawBody, secret, now = Date.now() }) {
  if (!secret || secret.length < 10 || secret.length > 100 ||
      !/^[\w-]{10,180}$/.test(String(id || '')) ||
      typeof timestamp !== 'string' || !signature?.startsWith('sha256=') ||
      !/^[0-9a-f]{64}$/.test(signature.slice(7))) return false;
  const age = Math.abs(now - Date.parse(timestamp));
  if (!Number.isFinite(age) || age > 10 * 60 * 1000) return false;
  const expected = createHmac('sha256', secret)
    .update(id).update(timestamp).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export default async function handleTwitchWebhook(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ code: 'method_not_allowed' });
  const secret = process.env.TWITCH_EVENTSUB_SECRET || '';
  if (secret.length < 10) return res.status(503).json({ code: 'webhook_not_configured' });
  let raw;
  try { raw = await readTwitchRawBody(req); }
  catch { return res.status(413).json({ code: 'payload_too_large' }); }
  const id = String(req.headers['twitch-eventsub-message-id'] || '');
  const timestamp = String(req.headers['twitch-eventsub-message-timestamp'] || '');
  const signature = String(req.headers['twitch-eventsub-message-signature'] || '');
  if (!verifyTwitchSignature({ id, timestamp, signature, rawBody: raw, secret })) {
    // An EventSub subscription can remain enabled even after the server-side
    // signing secret changes. Log a safe diagnostic, never the secret or body.
    console.warn('twitch_webhook_signature_rejected', {
      messageType: String(req.headers['twitch-eventsub-message-type'] || 'unknown').slice(0, 64),
      hasMessageId: Boolean(id), payloadBytes: raw.length,
    });
    return res.status(403).json({ code: 'invalid_signature' });
  }
  let frame;
  try { frame = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ code: 'malformed_payload' }); }
  const type = String(req.headers['twitch-eventsub-message-type'] || '');
  if (type === 'webhook_callback_verification') {
    const challenge = String(frame?.challenge || '');
    if (!challenge || challenge.length > 500) return res.status(400).json({ code: 'invalid_challenge' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    console.info('twitch_webhook_verified');
    return res.status(200).send(challenge);
  }
  if (type === 'revocation') {
    console.warn('twitch_webhook_revoked', { reason: String(frame?.subscription?.status || 'unknown') });
    return res.status(204).end();
  }
  if (type !== 'notification' || frame?.subscription?.type !== 'channel.chat.message') {
    return res.status(204).end();
  }
  const event = frame.event || {};
  // The event is authenticated, but always check the channel and sender.
  if (String(event.broadcaster_user_login || '').toLowerCase() !== '2o3a') {
    return res.status(204).end();
  }
  const messageId = String(event.message_id || id);
  const subscriptionId = String(frame.subscription?.id || '');
  try {
    const db = await getVerifiedFirestore();
    const result = await persistChatEvent(db, { event, messageId, subscriptionId });
    // Return 2xx ONLY after durable Firestore confirmation. Twitch retries
    // transient 5xx responses and our transaction deduplicates redeliveries.
    console.info('twitch_webhook_committed', { status: result.status, queued: result.queued });
    return res.status(204).end();
  } catch (error) {
    console.error('twitch_webhook_write_failed', {
      code: String(error?.code || 'webhook_queue_write_failed').slice(0, 80),
      message: String(error?.message || '').slice(0, 140),
    });
    return res.status(503).json({ code: 'webhook_queue_write_failed' });
  }
}
