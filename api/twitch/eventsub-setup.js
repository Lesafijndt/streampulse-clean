import { createHmac } from 'node:crypto';
import { getFirebaseAdminDb, getFirebaseNamespace } from '../_lib/firebase-admin.js';
import { classifyFirebaseHealthError } from '../_lib/firebase-health-diagnostic.js';
import { waitUntil } from '@vercel/functions';
import { processPendingEventSubChatMessages } from '../_lib/cloud-chat-requests.js';
import { shouldScheduleEventSubDrain, EVENTSUB_STATUS_DRAIN_INTERVAL_MS } from '../_lib/eventsub-drain-throttle.js';

const STREAMER_LOGIN = '2o3a';
const BOT_LOGIN = 'gachibot69';
const MODERATOR_LOGIN = 'paim_beach_pete';
const ALLOWED_STAFF = new Set(['2o3a', 'paim_beach_pete']);
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 400;
const REQUIRED_BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];
let cachedAppToken = { value: '', expiresAt: 0 };
let lastInboxDrainScheduledAt = 0;

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((value) => value.trim()).filter(Boolean).map((value) => {
    const index = value.indexOf('=');
    try { return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))]; }
    catch { return [value.slice(0, index), '']; }
  }));
}
function appendCookie(res, cookieValue) {
  const previous = res.getHeader('Set-Cookie');
  const current = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader('Set-Cookie', [...current, cookieValue]);
}
function setCookie(res, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
function clearCookies(res, prefix) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, [
    `${prefix}_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `${prefix}_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
}
function getOrigin(req) {
  const configured = String(process.env.TWITCH_APP_URL || '').trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req?.headers?.host || '').split(',')[0].trim();
  const requestProto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim().toLowerCase();
  const requestOrigin = requestHost ? `${requestProto}://${requestHost}` : '';
  const vercelHost = String(process.env.VERCEL_URL || '').trim();
  const candidate = configured || requestOrigin || (vercelHost ? `https://${vercelHost}` : 'https://streampulse-clean.vercel.app');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('The public app URL must be HTTPS');
  return parsed.origin;
}
function eventSubSecret() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch OAuth is not configured');
  return createHmac('sha256', clientSecret).update(`whale-cum-eventsub-v1:${clientId}`).digest('hex');
}
async function validateAccessToken(accessToken) {
  if (!accessToken) return null;
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}
export async function loadUserSession(req, res, kind) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const isStaff = kind === 'staff';
  const accessCookie = isStaff ? 'yedi_twitch_access' : 'yedi_twitch_bot_access';
  const refreshCookie = isStaff ? 'yedi_twitch_refresh' : 'yedi_twitch_bot_refresh';
  const expectedLogin = isStaff ? '' : BOT_LOGIN;
  let accessToken = cookies[accessCookie] || '';
  let refreshToken = cookies[refreshCookie] || '';
  let validation = await validateAccessToken(accessToken);

  if (!validation && refreshToken && clientSecret && clientId) {
    const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(6500),
      cache: 'no-store',
    });
    const refreshed = await refreshResponse.json().catch(() => ({}));
    if (refreshResponse.ok && refreshed.access_token) {
      accessToken = refreshed.access_token;
      if (refreshed.refresh_token) refreshToken = refreshed.refresh_token;
      validation = await validateAccessToken(accessToken);
      if (validation) {
        setCookie(res, accessCookie, accessToken, Math.max(1, Math.min(Number(validation.expires_in) || 14400, 14400)));
        if (refreshToken) setCookie(res, refreshCookie, refreshToken, REMEMBERED_SESSION_MAX_AGE);
      }
    } else {
      clearCookies(res, isStaff ? 'yedi_twitch' : 'yedi_twitch_bot');
    }
  }

  const validatedLogin = String(validation?.login || '').toLowerCase();
  if (!clientId || !validation || validation.client_id !== clientId ||
      (isStaff ? !ALLOWED_STAFF.has(validatedLogin) : validatedLogin !== expectedLogin)) {
    return { ok: false, code: isStaff ? 'staff_reauth_required' : 'bot_reauth_required' };
  }
  return {
    ok: true,
    token: accessToken,
    login: String(validation.login || '').toLowerCase(),
    userId: String(validation.user_id || ''),
    scopes: new Set(Array.isArray(validation.scopes) ? validation.scopes : []),
  };
}
async function getAppAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedAppToken.value && cachedAppToken.expiresAt > Date.now() + 60000) {
    return cachedAppToken.value;
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Twitch OAuth is not configured');
  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(6500),
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error('Could not obtain Twitch app access token');
  cachedAppToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
  };
  return cachedAppToken.value;
}
async function twitchApi(path, options = {}) {
  let token = await getAppAccessToken();
  const call = (accessToken) => fetch(`https://api.twitch.tv/helix/${path}`, {
    ...options,
    headers: {
      'Client-Id': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(7000),
    cache: 'no-store',
  });
  let response = await call(token);
  if (response.status === 401) {
    token = await getAppAccessToken(true);
    response = await call(token);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = String(body.message || `Twitch API returned HTTP ${response.status}`);
    const error = new Error(reason);
    error.status = response.status;
    throw error;
  }
  return body;
}
async function resolveUserIds() {
  const users = await twitchApi('users?login=2o3a&login=gachibot69');
  const byLogin = new Map((users.data || []).map((user) => [String(user.login || '').toLowerCase(), String(user.id || '')]));
  const broadcasterId = byLogin.get(STREAMER_LOGIN) || '';
  const botId = byLogin.get(BOT_LOGIN) || '';
  if (!broadcasterId || !botId) throw new Error('Could not resolve Twitch broadcaster or bot account');
  return { broadcasterId, botId };
}
async function findSubscription(origin, broadcasterId, botId) {
  const result = await twitchApi('eventsub/subscriptions?type=channel.chat.message&first=100');
  const subscriptions = Array.isArray(result.data) ? result.data : [];
  return subscriptions.find((item) =>
    String(item.condition?.broadcaster_user_id || '') === broadcasterId &&
    String(item.condition?.user_id || '') === botId &&
    String(item.transport?.method || '') === 'webhook' &&
    String(item.transport?.callback || '').replace(/\/$/, '') === `${origin}/api/twitch/eventsub`
  ) || null;
}
function statusResult(subscription) {
  const status = String(subscription?.status || '');
  if (status === 'enabled') {
    return { active: true, status: 'active', message: 'Cloud chat listener is active. Requests are stored centrally even when the dashboard is closed.' };
  }
  if (status === 'webhook_callback_verification_pending') {
    return { active: false, status: 'pending', code: 'subscription_pending', message: 'Twitch is verifying the cloud chat listener. This usually resolves shortly.' };
  }
  if (status) {
    const code = 'subscription_' + status.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return { active: false, status: 'error', code, message: `Twitch reports the cloud chat subscription is ${status}. Reload the moderator dashboard to retry setup after checking bot authorization.` };
  }
  return { active: false, status: 'inactive', code: 'not_configured', message: 'Cloud chat listener is not configured yet.' };
}
function getMissingScopeMessage(_staff, bot) {
  // With an app access token Twitch accepts either broadcaster channel:bot authorization
  // OR moderator status for the chatting bot. Do not incorrectly block moderator-operated
  // setup just because the broadcaster's current dashboard token lacks channel:bot.
  if (!REQUIRED_BOT_SCOPES.every((scope) => bot.scopes.has(scope))) {
    return {
      active: false, status: 'needs_authorization', code: 'bot_scope_missing',
      message: '@gachibot69 must reconnect and grant user:read:chat, user:write:chat, and user:bot.',
    };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (!['GET', 'POST'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const staff = await loadUserSession(req, res, 'staff');
  if (!staff.ok) return res.status(401).json({ active: false, status: 'needs_authorization', code: staff.code, message: 'Sign in as an approved staff account to check cloud chat setup.' });
  const bot = await loadUserSession(req, res, 'bot');

  if (req.method === 'POST') {
    // The streamer only uses the player. The moderator owns EventSub setup.
    if (staff.login !== MODERATOR_LOGIN) {
      return res.status(403).json({ active: false, status: 'error', code: 'moderator_required', message: 'Only paim_beach_pete can configure cloud Twitch chat intake.' });
    }
    let origin;
    try {
      origin = getOrigin(req);
      const configuredOrigin = origin;
      if (String(req.headers.origin || '') !== configuredOrigin) {
        return res.status(403).json({ active: false, status: 'error', code: 'origin_mismatch', message: 'Setup must be started from the WHALE CUM dashboard.' });
      }
    } catch (error) {
      return res.status(500).json({ active: false, status: 'error', code: 'origin_not_configured', message: 'Set TWITCH_APP_URL in Vercel to the production HTTPS site.' });
    }

    // Only the approved moderator may run setup. Twitch validates whether
    // @gachibot69 is a channel moderator or the broadcaster granted channel:bot.
    // If an active subscription already exists, don't demand new scopes or create a duplicate.
    try {
      const { broadcasterId, botId } = await resolveUserIds();
      const existing = await findSubscription(origin, broadcasterId, botId);
      if (String(existing?.status || '') === 'enabled') return res.status(200).json(statusResult(existing));
      if (String(existing?.status || '') === 'webhook_callback_verification_pending') {
        return res.status(200).json(statusResult(existing));
      }

      if (!bot.ok) return res.status(401).json({ active: false, status: 'needs_authorization', code: bot.code, message: 'Reconnect @gachibot69 to configure cloud chat capture.' });
      const missingScope = getMissingScopeMessage(staff, bot);
      if (missingScope) return res.status(403).json(missingScope);
      // The dashboard must have its public Firebase configuration as well as Admin
      // credentials, otherwise the server could accept requests that no browser can display.
      const requiredWebConfig = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'];
      if (requiredWebConfig.some((key) => !String(process.env[key] || '').trim())) {
        return res.status(503).json({
          active: false,
          status: 'error',
          code: 'firebase_config_missing',
          message: 'Cloud chat capture needs the Firebase web config (VITE_FIREBASE_API_KEY, VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID) in Vercel.',
        });
      }

      // Fail setup loudly if the same Admin credentials used for queue writes cannot reach Firestore.
      const db = await getFirebaseAdminDb();
      await db.doc(`artifacts/${getFirebaseNamespace()}/public/data/room_settings/${STREAMER_LOGIN}`).get();

      if (existing?.id) {
        // Remove stale failed/revoked subscriptions only after authorization and Firestore
        // have been verified, so the working setup is never discarded prematurely.
        await twitchApi('eventsub/subscriptions?id=' + encodeURIComponent(String(existing.id)), { method: 'DELETE' });
      }

      const callback = `${origin}/api/twitch/eventsub`;
      const secret = eventSubSecret();
      const created = await twitchApi('eventsub/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          type: 'channel.chat.message',
          version: '1',
          condition: { broadcaster_user_id: broadcasterId, user_id: botId },
          transport: { method: 'webhook', callback, secret },
        }),
      });
      const subscription = (created.data || [])[0] || null;
      return res.status(200).json(statusResult(subscription));
    } catch (error) {
      const status = Number(error?.status) || 500;
      const message = String(error?.message || '');
      console.error('Twitch EventSub setup failed:', message.slice(0, 500));
      const firebaseFailure = /firebase|firestore|service account|credential|permission denied|quota|project|could not get document|web config/i.test(message);
      return res.status(firebaseFailure ? 503 : (status >= 400 && status < 500 ? status : 502)).json({
        active: false,
        status: 'error',
        code: firebaseFailure ? 'firebase_unavailable' : (status === 403 ? 'twitch_permission_denied' : 'setup_failed'),
        message: firebaseFailure
          ? 'Cloud chat capture cannot start because Firestore is unavailable. Check Firebase service-account configuration, access, and quota.'
          : status === 403
            ? 'Twitch denied the subscription. Ensure @gachibot69 is a moderator in 2o3a chat (or reauthorize 2o3a with channel:bot), then retry.'
            : 'Could not configure the Twitch cloud chat listener. Check the Twitch EventSub/API configuration and retry.',
      });
    }
  }

  // GET checks listener state and schedules one pending inbox retry; it never creates subscriptions.
  try {
    const origin = getOrigin(req);
    const { broadcasterId, botId } = await resolveUserIds();
    const subscription = await findSubscription(origin, broadcasterId, botId);
    const currentStatus = statusResult(subscription);
    let roomSettingsSnapshot;
    let latestInboxSnapshot;
    try {
      const db = await getFirebaseAdminDb();
      const namespace = getFirebaseNamespace();
      [roomSettingsSnapshot, latestInboxSnapshot] = await Promise.all([
        db.doc('artifacts/' + namespace + '/public/data/room_settings/' + STREAMER_LOGIN).get(),
        db.collection('artifacts/' + namespace + '/public/data/chat_request_inbox')
          .orderBy('receivedAt', 'desc').limit(1).get(),
      ]);
    } catch (error) {
      const diagnostic = classifyFirebaseHealthError(error);
      const firebaseAdminConfigured = Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim());
      const firebaseWebConfigConfigured = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']
        .every((key) => Boolean(String(process.env[key] || '').trim()));
      console.error('Cloud chat listener Firestore health check failed:', { code: diagnostic.code, message: diagnostic.message });
      return res.status(200).json({
        ...currentStatus,
        subscriptionStatus: String(currentStatus.status || 'unknown'),
        active: false,
        status: 'error',
        code: 'firebase_unavailable',
        firestoreStatus: 'unavailable',
        healthDiagnosticCode: diagnostic.code,
        healthDiagnosticMessage: diagnostic.message,
        firebaseAdminConfigured,
        firebaseWebConfigConfigured,
        lastWriteStatus: 'unknown',
        message: 'Twitch subscription was found, but the Firestore health check failed. Shared queue requests may not save until this is fixed.',
      });
    }
    const roomSettings = roomSettingsSnapshot?.exists ? roomSettingsSnapshot.data() : {};
    const health = roomSettings?.chatIntakeHealth && typeof roomSettings.chatIntakeHealth === 'object'
      ? roomSettings.chatIntakeHealth : {};
    const latestInbox = latestInboxSnapshot?.docs?.[0]?.data?.() || null;
    const lastWriteAt = Number(health.lastWriteAt) || 0;
    const lastWebhookAt = Math.max(Number(health.lastWebhookAt) || 0, Number(latestInbox?.receivedAt) || 0);
    const latestInboxStatus = String(latestInbox?.status || '');
    const latestInboxError = String(latestInbox?.lastError || '').slice(0, 180);
    const writeAge = lastWriteAt > 0 ? Math.max(0, Math.floor((Date.now() - lastWriteAt) / 60000)) : null;
    const healthMessage = lastWriteAt > 0
      ? ' Last successful server queue write: ' + (writeAge < 1 ? 'under 1 minute ago.' : writeAge + ' minute(s) ago.')
      : ' Waiting for the first successful queue write.';
    const withHealth = {
      ...currentStatus,
      firestoreStatus: 'connected',
      lastWriteAt: lastWriteAt || null,
      lastWebhookAt: lastWebhookAt || null,
      lastWriteStatus: String(health.lastWriteStatus || 'unknown'),
      lastWriteSource: String(health.lastWriteSource || ''),
      lastWebhookStatus: latestInbox ? 'persisted' : String(health.lastWebhookStatus || 'unknown'),
      lastProcessingError: latestInboxError || (latestInbox ? '' : String(health.lastProcessingError || '').slice(0, 180)),
      lastProcessingErrorAt: latestInboxError
        ? Number(latestInbox?.lastFailedAt) || null
        : (latestInbox ? null : Number(health.lastProcessingErrorAt) || null),
      lastProcessingStatus: latestInbox
        ? latestInboxStatus === 'processed' ? 'ok'
          : latestInboxError ? (latestInboxStatus === 'failed' ? 'failed' : 'retrying')
            : latestInboxStatus || 'unknown'
        : String(health.lastProcessingStatus || 'unknown'),
      queueVersion: Number(roomSettings.queueVersion) || 0,
      queueUpdatedAt: Number(roomSettings.queueUpdatedAt) || null,
      subscriptionStatus: String(currentStatus.status || 'unknown'),
      healthDiagnosticCode: '',
      healthDiagnosticMessage: '',
      firebaseAdminConfigured: Boolean(String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()),
      firebaseWebConfigConfigured: ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']
        .every((key) => Boolean(String(process.env[key] || '').trim())),
      message: currentStatus.message + healthMessage +
        (health.lastProcessingError ? ' Last processing error: ' + String(health.lastProcessingError).slice(0, 140) : ''),
    };
    if (currentStatus.active || currentStatus.status === 'pending') {
      // Status checks are polled by authenticated dashboards. Drain failed/pending inbox
      // messages only occasionally here; incoming EventSub deliveries trigger processing
      // immediately, so polling is a recovery path, not the primary worker.
      const now = Date.now();
      if (shouldScheduleEventSubDrain(now, lastInboxDrainScheduledAt)) {
        lastInboxDrainScheduledAt = now;
        try {
          waitUntil(processPendingEventSubChatMessages(2).catch((error) => {
            console.error('EventSub status-triggered inbox drain failed:', String(error?.message || error).slice(0, 300));
          }));
        } catch (error) {
          console.warn('Could not schedule EventSub inbox drain from status check:', String(error?.message || error).slice(0, 240));
        }
      }
      return res.status(200).json(withHealth);
    }
    if (bot.ok) {
      const missingScope = getMissingScopeMessage(staff, bot);
      if (missingScope) return res.status(200).json(missingScope);
    } else {
      return res.status(200).json({ active: false, status: 'needs_authorization', code: bot.code, message: 'Reconnect @gachibot69 and grant the new chat-reading permissions to enable cloud requests.' });
    }
    return res.status(200).json(withHealth);

  } catch (error) {
    console.error('Twitch EventSub status failed:', String(error?.message || error).slice(0, 500));
    return res.status(200).json({
      active: false,
      status: 'unavailable',
      code: 'status_unavailable',
      firestoreStatus: 'unknown',
      message: 'Could not verify the cloud chat listener. Check connection details and retry.',
    });
  }
}
