import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { isEventSubChatCandidate, persistEventSubInbox, processPendingEventSubChatMessages } from '../_lib/cloud-chat-requests.js';

export const config = {
  api: { bodyParser: false },
};

const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

function getEventSubSecret() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch OAuth is not configured');
  // Derive a stable, high-entropy webhook secret from the server-only Twitch client
  // secret so no extra environment variable is required for first-time setup.
  return createHmac('sha256', clientSecret)
    .update(`whale-cum-eventsub-v1:${clientId}`)
    .digest('hex');
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function isValidEventSubSignature(secret, messageId, timestamp, rawBody, headerSignature) {
  if (!messageId || !timestamp || !headerSignature) return false;
  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(Date.now() - parsedTimestamp) > MAX_MESSAGE_AGE_MS) {
    return false;
  }
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(messageId)
    .update(timestamp)
    .update(rawBody)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(String(headerSignature));
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  let rawBody;
  let payload;
  try {
    rawBody = await readRawBody(req);
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid EventSub payload');
  }

  const messageId = String(req.headers['twitch-eventsub-message-id'] || '');
  const timestamp = String(req.headers['twitch-eventsub-message-timestamp'] || '');
  const signature = String(req.headers['twitch-eventsub-message-signature'] || '');
  let secret;
  try {
    secret = getEventSubSecret();
  } catch (error) {
    console.error('Twitch EventSub is not configured:', error?.message || error);
    return res.status(503).send('EventSub is not configured');
  }

  if (!isValidEventSubSignature(secret, messageId, timestamp, rawBody, signature)) {
    return res.status(403).send('Invalid EventSub signature');
  }

  const messageType = String(req.headers['twitch-eventsub-message-type'] || '');
  if (messageType === 'webhook_callback_verification') {
    if (typeof payload.challenge !== 'string') return res.status(400).send('Missing verification challenge');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(payload.challenge);
  }

  if (messageType === 'revocation') {
    console.warn('Twitch EventSub subscription revoked:', {
      type: String(payload.subscription?.type || ''),
      status: String(payload.subscription?.status || ''),
    });
    return res.status(204).end();
  }

  if (messageType !== 'notification' ||
      String(payload.subscription?.type || '') !== 'channel.chat.message' ||
      !payload.event) {
    return res.status(204).end();
  }

  if (!isEventSubChatCandidate(payload.event)) return res.status(204).end();
  try {
    // Persist first; title search, TikTok resolution, metadata and replies run after
    // Twitch receives the webhook acknowledgement.
    await persistEventSubInbox({ event: payload.event, messageId });
  } catch (error) {
    console.error('Twitch EventSub notification could not be persisted:', {
      code: String(error?.code || 'unknown'),
      message: String(error?.message || error).slice(0, 500),
    });
    return res.status(503).send('Could not persist chat request');
  }
  try {
    waitUntil(processPendingEventSubChatMessages(2).catch((error) => {
      console.error('EventSub inbox worker failed; messages remain pending:', String(error?.message || error).slice(0, 400));
    }));
  } catch (error) {
    // The durable inbox remains available if background scheduling is unavailable locally.
    console.warn('Could not start EventSub background worker:', String(error?.message || error).slice(0, 300));
  }
  return res.status(204).end();
}
