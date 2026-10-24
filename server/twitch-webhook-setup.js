import { obtainSession } from './chat-subscribe.js';
import { getVerifiedFirestore, getQueueNamespace } from './firebase-guard.js';

const CALLBACK_PATH = '/api/twitch/bot-session?action=webhook';
const BOT_SCOPES = ['user:read:chat', 'user:bot'];

async function appAccessToken() {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw Object.assign(new Error('Twitch app credentials not configured'), { code: 'twitch_app_not_configured' });
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(7000), cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw Object.assign(new Error('Unable to authenticate Twitch app'), { code: 'twitch_app_token_failed' });
  return {
    'Client-Id': id, Authorization: 'Bearer ' + data.access_token,
    'Content-Type': 'application/json',
  };
}

async function getBroadcasterId(headers) {
  const response = await fetch('https://api.twitch.tv/helix/users?login=2o3a', {
    headers, signal: AbortSignal.timeout(6000), cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  const id = String(body.data?.[0]?.id || '');
  if (!response.ok || !id) throw Object.assign(new Error('Unable to look up 2o3a'), { code: 'broadcaster_lookup_failed' });
  return id;
}

function expectedCallback() {
  const origin = new URL(process.env.TWITCH_APP_URL || 'https://streampulse-clean.vercel.app').origin;
  if (origin !== 'https://streampulse-clean.vercel.app') {
    throw Object.assign(new Error('Only the production Twitch callback is supported'), { code: 'callback_origin_mismatch' });
  }
  return origin + CALLBACK_PATH;
}

async function recentWebhookDelivery() {
  const db = await getVerifiedFirestore();
  const base = db.collection('artifacts').doc(getQueueNamespace())
    .collection('public').doc('data').collection('twitch_eventsub_receipts');
  const snapshot = await base.orderBy('receivedAt', 'desc').limit(1).get();
  const latest = snapshot.docs?.[0]?.data() || {};
  return {
    lastWebhookAt: Number(latest.receivedAt) || 0,
    lastWebhookResult: String(latest.status || 'none').slice(0, 50),
    lastWebhookQueued: Number(latest.queued) || 0,
  };
}

async function getSubscriptions(headers) {
  const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message', {
    headers, signal: AbortSignal.timeout(7000), cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('Unable to read Twitch subscriptions'), { code: 'subscription_lookup_failed' });
  return Array.isArray(result.data) ? result.data : [];
}

export default async function configureWebhook(req, res, { statusOnly = false } = {}) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!statusOnly && (!host || String(req.headers.origin || '') !== proto + '://' + host)) {
    return res.status(403).json({ ok: false, code: 'origin_denied' });
  }
  try {
    const staff = await obtainSession(req, res, 'staff');
    if (!staff) return res.status(403).json({ ok: false, code: 'moderator_required' });
    if (!process.env.TWITCH_EVENTSUB_SECRET || process.env.TWITCH_EVENTSUB_SECRET.length < 10) {
      return res.status(503).json({ ok: false, code: 'webhook_secret_missing' });
    }
    const callback = expectedCallback();
    const headers = await appAccessToken();
    const broadcasterId = await getBroadcasterId(headers);
    const bot = await obtainSession(req, res, 'bot');
    if (!bot) return res.status(401).json({ ok: false, code: 'bot_login_required' });
    if (!BOT_SCOPES.every(scope => bot.scopes.includes(scope))) {
      return res.status(403).json({ ok: false, code: 'bot_webhook_scopes_missing', missing: BOT_SCOPES.filter(scope => !bot.scopes.includes(scope)) });
    }
    const all = await getSubscriptions(headers);
    const existing = all.find(entry =>
      entry.type === 'channel.chat.message' &&
      String(entry.condition?.broadcaster_user_id) === broadcasterId &&
      String(entry.condition?.user_id) === bot.userId &&
      entry.transport?.method === 'webhook' &&
      entry.transport?.callback === callback &&
      ['enabled', 'webhook_callback_verification_pending'].includes(entry.status));
    // A successful Twitch subscription alone does NOT prove that the Firestore
    // queue project works. Surface a safe status for the moderator.
    const firestore = await recentWebhookDelivery();
    if (existing) {
      return res.status(200).json({ ok: true, active: existing.status === 'enabled',
        status: existing.status, code: 'webhook_existing', ...firestore });
    }
    if (statusOnly) return res.status(200).json({
      ok: true, active: false, code: 'webhook_not_subscribed', ...firestore,
    });
    const created = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', headers, signal: AbortSignal.timeout(8000), cache: 'no-store',
      body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: bot.userId },
        transport: { method: 'webhook', callback, secret: process.env.TWITCH_EVENTSUB_SECRET },
      }),
    });
    const result = await created.json().catch(() => ({}));
    if (!created.ok) {
      console.warn('twitch_webhook_subscription_rejected', {
        status: created.status, message: String(result.message || '').slice(0, 180),
      });
      return res.status(502).json({
        ok: false, code: 'twitch_webhook_subscription_rejected',
        reason: created.status === 403 ? 'bot_must_be_channel_moderator_or_have_channel_bot_grant' : 'twitch_rejected_request',
      });
    }
    return res.status(202).json({ ok: true, active: false,
      status: result.data?.[0]?.status || 'webhook_callback_verification_pending',
      code: 'webhook_verification_pending' });
  } catch (error) {
    console.error('twitch_webhook_configuration_failed', { code: String(error?.code || 'unknown') });
    return res.status(503).json({ ok: false, code: String(error?.code || 'webhook_setup_unavailable') });
  }
}
