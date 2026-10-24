import { obtainSession } from './chat-subscribe.js';
import { getVerifiedFirestore, getQueueNamespace } from './firebase-guard.js';

const CALLBACK_PATH = '/api/twitch/bot-session?action=webhook';
const MODERATOR_CHAT_SCOPES = ['user:read:chat', 'user:bot'];

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

let lastReceiptProbe = { at: 0, value: null };
async function recentWebhookDelivery() {
  // Cache moderator health reads for five minutes so the status panel never
  // burns through the Firestore free tier simply by remaining open.
  if (lastReceiptProbe.value && Date.now() - lastReceiptProbe.at < 5 * 60_000) {
    return lastReceiptProbe.value;
  }
  let value;
  try {
    const db = await getVerifiedFirestore();
    const base = db.collection('artifacts').doc(getQueueNamespace())
      .collection('public').doc('data').collection('twitch_eventsub_receipts');
    const snapshot = await base.orderBy('receivedAt', 'desc').limit(1).get();
    const latest = snapshot.docs?.[0]?.data() || {};
    value = {
      lastWebhookAt: Number(latest.receivedAt) || 0,
      lastWebhookResult: String(latest.status || 'none').slice(0, 50),
      lastWebhookQueued: Number(latest.queued) || 0,
      receiptCode: 'ok',
    };
  } catch (error) {
    const diagnostic = String(error?.code || error?.message || '');
    value = {
      lastWebhookAt: 0, lastWebhookResult: 'unknown', lastWebhookQueued: 0,
      receiptCode: /RESOURCE_EXHAUSTED|quota|\b8\b/i.test(diagnostic)
        ? 'firestore_quota_exceeded' : 'firestore_receipts_unavailable',
    };
  }
  lastReceiptProbe = { at: Date.now(), value };
  return value;
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
    // Check the already-verified user grant BEFORE making unnecessary Twitch
    // app-token and broadcaster API calls on every status refresh.
    if (!MODERATOR_CHAT_SCOPES.every(scope => staff.scopes.includes(scope))) {
      return res.status(403).json({
        ok: false, code: 'moderator_chat_scopes_missing',
        missing: MODERATOR_CHAT_SCOPES.filter(scope => !staff.scopes.includes(scope)),
      });
    }
    if (!process.env.TWITCH_EVENTSUB_SECRET || process.env.TWITCH_EVENTSUB_SECRET.length < 10) {
      return res.status(503).json({ ok: false, code: 'webhook_secret_missing' });
    }
    const callback = expectedCallback();
    const headers = await appAccessToken();
    const broadcasterId = await getBroadcasterId(headers);
    const all = await getSubscriptions(headers);
    const existing = all.find(entry =>
      entry.type === 'channel.chat.message' &&
      String(entry.condition?.broadcaster_user_id) === broadcasterId &&
      String(entry.condition?.user_id) === staff.userId &&
      entry.transport?.method === 'webhook' &&
      entry.transport?.callback === callback &&
      ['enabled', 'webhook_callback_verification_pending'].includes(entry.status));
    // A successful Twitch subscription alone does NOT prove that the Firestore
    // queue project works. Surface a safe status for the moderator.
    const firestore = await recentWebhookDelivery();
    const repair = !statusOnly && String(req.query?.repair || '') === '1';
    if (existing && !repair) {
      return res.status(200).json({ ok: true, active: existing.status === 'enabled',
        status: existing.status, code: 'webhook_existing', ...firestore });
    }
    if (existing && repair) {
      // Explicit moderator-controlled recovery for a subscription signed with
      // an older TWITCH_EVENTSUB_SECRET. Only touch this app's own callback,
      // broadcaster, and moderator registration; never other subscriptions.
      const id = String(existing.id || '');
      if (!/^[A-Za-z0-9_-]{6,140}$/.test(id)) {
        return res.status(502).json({ ok: false, code: 'invalid_webhook_subscription_id' });
      }
      const deletion = await fetch(
        'https://api.twitch.tv/helix/eventsub/subscriptions?id=' + encodeURIComponent(id),
        { method: 'DELETE', headers, signal: AbortSignal.timeout(8000), cache: 'no-store' },
      );
      if (!deletion.ok && deletion.status !== 404) {
        return res.status(502).json({ ok: false, code: 'webhook_repair_delete_failed' });
      }
      console.info('twitch_webhook_subscription_repair_requested');
    }
    if (statusOnly) return res.status(200).json({
      ok: true, active: false, code: 'webhook_not_subscribed', ...firestore,
    });
    const created = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', headers, signal: AbortSignal.timeout(8000), cache: 'no-store',
      body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: staff.userId },
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
        reason: created.status === 403 ? 'moderator_chat_grant_or_channel_status_missing' : 'twitch_rejected_request',
      });
    }
    return res.status(202).json({ ok: true, active: false,
      status: result.data?.[0]?.status || 'webhook_callback_verification_pending',
      code: repair ? 'webhook_repair_pending' : 'webhook_verification_pending' });
  } catch (error) {
    console.error('twitch_webhook_configuration_failed', { code: String(error?.code || 'unknown') });
    return res.status(503).json({ ok: false, code: String(error?.code || 'webhook_setup_unavailable') });
  }
}
