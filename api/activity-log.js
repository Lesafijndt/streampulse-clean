import { normalizeActivityEvent } from '../src/activityLog.js';

const ALLOWED_STAFF = new Set(['2o3a', 'paim_beach_pete']);
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 400;
const DEFAULT_APP_ID = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck';

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    try { return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))]; }
    catch { return [item.slice(0, index), '']; }
  }));
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  try { return JSON.parse(body); } catch { return {}; }
}

function appendCookie(res, cookieValue) {
  const previous = res.getHeader('Set-Cookie');
  const current = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader('Set-Cookie', [...current, cookieValue]);
}

function setAuthCookie(res, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function validateStaff(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return { error: 'Twitch authentication is not configured.', status: 503 };
  const cookies = parseCookies(req.headers.cookie);
  let accessToken = cookies.yedi_twitch_access || '';
  let refreshToken = cookies.yedi_twitch_refresh || '';
  if (!accessToken && !refreshToken) return { error: 'Sign in as an approved staff account first.', status: 401 };

  const validate = async (token) => {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };

  let identity = null;
  try {
    if (accessToken) identity = await validate(accessToken);
  } catch {
    return { error: 'Twitch authentication could not be checked. Retry shortly.', status: 502 };
  }

  // Access cookies expire with the short-lived token. A surviving remember-me
  // cookie must still be able to restore the session for activity reads and writes.
  if (!identity && refreshToken && process.env.TWITCH_CLIENT_SECRET) {
    try {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: process.env.TWITCH_CLIENT_SECRET
        }),
        signal: AbortSignal.timeout(5000)
      });
      const refreshed = await refreshResponse.json().catch(() => ({}));
      if (refreshResponse.ok && refreshed.access_token) {
        accessToken = refreshed.access_token;
        if (refreshed.refresh_token) refreshToken = refreshed.refresh_token;
        identity = await validate(accessToken);
      } else {
        clearAuthCookies(res);
      }
    } catch {
      return { error: 'Twitch authentication could not be refreshed. Retry shortly.', status: 502 };
    }
  }

  const login = String(identity?.login || '').toLowerCase();
  if (!identity || identity.client_id !== clientId || !ALLOWED_STAFF.has(login)) {
    clearAuthCookies(res);
    return { error: 'An approved Twitch staff session is required.', status: 401 };
  }

  // Keep the short-lived access cookie and extend the persistent refresh cookie
  // consistently with /api/twitch/session.
  setAuthCookie(res, 'yedi_twitch_access', accessToken, Math.max(1, Math.min(Number(identity.expires_in) || 14400, 14400)));
  if (refreshToken) setAuthCookie(res, 'yedi_twitch_refresh', refreshToken, REMEMBERED_SESSION_MAX_AGE);
  return { login };
}

function getAppId(rawValue) {
  const candidate = String(rawValue || DEFAULT_APP_ID).trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(candidate)) return '';
  // The API must not let an approved user use Firebase Admin to read another namespace.
  return candidate === DEFAULT_APP_ID ? candidate : '';
}

async function getAdminFirestore() {
  const [{ cert, getApps, initializeApp }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore')
  ]);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Firebase Admin is not configured');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch {
    try { serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('Firebase Admin configuration is invalid'); }
  }
  if (!serviceAccount || typeof serviceAccount !== 'object' ||
      typeof serviceAccount.project_id !== 'string' ||
      typeof serviceAccount.client_email !== 'string' ||
      typeof serviceAccount.private_key !== 'string') {
    throw new Error('Firebase Admin configuration is incomplete');
  }
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  const name = 'whale-cum-activity-admin';
  const app = getApps().find((item) => item.name === name) ||
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, name);
  return getFirestore(app);
}


export function classifyActivityStorageError(error) {
  const message = String(error?.message || '');
  const code = String(error?.code ?? '').toLowerCase();

  if (/FIREBASE_SERVICE_ACCOUNT_JSON is not configured|Firebase Admin is not configured/i.test(message)) return 'missing_service_account';
  if (/not valid JSON or base64 JSON|must be a JSON object|missing the '(?:project_id|client_email|private_key)' field/i.test(message)) {
    return 'invalid_service_account_config';
  }
  if (/private.?key|PEM|invalid_grant|invalid jwt|credential|signBlob/i.test(message)) {
    return 'invalid_service_account_credentials';
  }
  if (/permission-denied|permission denied|missing or insufficient permissions/i.test(message) ||
      ['7', 'permission-denied'].includes(code)) return 'firestore_permission_denied';
  if (/API has not been used|serviceusage.*disabled|firestore.*disabled/i.test(message)) {
    return 'firestore_api_disabled';
  }
  if (/ERR_REQUIRE_ESM|Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return 'firebase_admin_import_failed';
  }
  if (/UNAVAILABLE|DEADLINE_EXCEEDED|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(message) ||
      ['14', 'unavailable', 'deadline-exceeded'].includes(code)) return 'firestore_temporarily_unavailable';
  if (/NOT_FOUND|not found|does not exist/i.test(message) ||
      ['5', 'not-found'].includes(code)) return 'firestore_project_or_resource_not_found';

  const safeCode = code.replace(/[^a-z0-9/_-]/g, '').slice(0, 48);
  return safeCode ? `firebase_error_${safeCode}` : 'unknown_storage_error';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let configuredOrigin = '';
  try {
    configuredOrigin = new URL(process.env.TWITCH_APP_URL || `https://${req.headers.host}`).origin;
  } catch { return res.status(503).json({ error: 'The app origin is not configured.' }); }
  const requestOrigin = req.headers.origin;
  // Vercel can serve the same project through multiple valid aliases. Keep the
  // exact-origin check, but also accept the origin that matches this request's
  // actual host so a stale TWITCH_APP_URL does not break same-origin sync.
  let requestHostOrigin = '';
  try { requestHostOrigin = new URL(`https://${req.headers.host}`).origin; }
  catch { return res.status(503).json({ error: 'The dashboard host is invalid.' }); }
  if ((requestOrigin && requestOrigin !== configuredOrigin && requestOrigin !== requestHostOrigin) ||
      (req.method === 'POST' && !requestOrigin)) {
    return res.status(403).json({ error: 'Activity requests must originate from the dashboard.' });
  }

  const identity = await validateStaff(req, res);
  if (!identity.login) return res.status(identity.status || 401).json({ error: identity.error || 'Not authorized.' });

  const body = req.method === 'POST' ? parseBody(req.body) : {};
  const appId = getAppId(req.method === 'GET' ? req.query?.appId : body.appId);
  if (!appId) return res.status(400).json({ error: 'Invalid activity namespace.' });

  try {
    const firestore = await getAdminFirestore();
    const events = firestore.collection('artifacts').doc(appId).collection('public').doc('data').collection('queue_events');

    if (req.method === 'GET') {
      const snapshot = await events.orderBy('at', 'asc').get();
      const rows = snapshot.docs.map((entry) => normalizeActivityEvent({ ...entry.data(), id: entry.id })).filter(Boolean);
      return res.status(200).json({ events: rows });
    }

    const event = normalizeActivityEvent(body.event);
    if (!event || !/^[A-Za-z0-9_-]{1,140}$/.test(event.id) || event.room !== '2o3a' || !event.mediaId) {
      return res.status(400).json({ error: 'Invalid activity event.' });
    }
    const eventRef = events.doc(event.id);
    const result = await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) return { duplicate: true };
      transaction.create(eventRef, event);
      return { duplicate: false };
    });
    return res.status(200).json({ ok: true, duplicate: result.duplicate });
  } catch (error) {
    const diagnostic = classifyActivityStorageError(error);
    console.error('Activity log API failed:', diagnostic, error?.message || error);
    return res.status(503).json({
      error: 'Activity log storage is temporarily unavailable.',
      diagnostic,
    });
  }
}
