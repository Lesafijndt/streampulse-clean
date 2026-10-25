import { normalizeActivityEvent } from '../src/activityLog.js';
import { decodeServiceAccount } from '../server/firebase-guard.js';

const ALLOWED_STAFF = new Set(['paim_beach_pete']);
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
  let accessToken = cookies.yedi_twitch_access;
  if (!accessToken) return { error: 'Sign in as an approved staff account first.', status: 401 };

  const validate = async (token) => {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };

  let identity = null;
  try { identity = await validate(accessToken); }
  catch { return { error: 'Twitch authentication could not be checked. Retry shortly.', status: 502 }; }

  if (!identity && cookies.yedi_twitch_refresh && process.env.TWITCH_CLIENT_SECRET) {
    try {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: cookies.yedi_twitch_refresh,
          client_id: clientId,
          client_secret: process.env.TWITCH_CLIENT_SECRET
        }),
        signal: AbortSignal.timeout(5000)
      });
      const refreshed = await refreshResponse.json().catch(() => ({}));
      if (refreshResponse.ok && refreshed.access_token) {
        accessToken = refreshed.access_token;
        setAuthCookie(res, 'yedi_twitch_access', refreshed.access_token, Math.min(Number(refreshed.expires_in) || 14400, 14400));
        if (refreshed.refresh_token) setAuthCookie(res, 'yedi_twitch_refresh', refreshed.refresh_token, 60 * 60 * 24 * 30);
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
    if (!identity) clearAuthCookies(res);
    return { error: 'An approved Twitch staff session is required.', status: 401 };
  }
  return { login };
}

function getAppId(rawValue) {
  const candidate = String(rawValue || DEFAULT_APP_ID).trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(candidate)) return '';
  // The API must not let an approved user use Firebase Admin to read another namespace.
  return candidate === DEFAULT_APP_ID ? candidate : '';
}

async function getAdminFirestore() {
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
    const { getVerifiedFirestore } = await import('../server/firebase-guard.js');
    return getVerifiedFirestore();
  }
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
  serviceAccount = decodeServiceAccount(raw);
  const name = 'whale-cum-activity-admin';
  const app = getApps().find((item) => item.name === name) ||
    initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, name);
  return getFirestore(app);
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
  if ((requestOrigin && requestOrigin !== configuredOrigin) || (req.method === 'POST' && !requestOrigin)) {
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
      // A full-collection query every 30 seconds exhausted Firestore's daily
      // quota and starved the live video queue. Page in stable at/id order and
      // let each moderator session request only new records afterwards.
      const at = Number(req.query?.afterAt || 0);
      const afterId = String(req.query?.afterId || '');
      if (!Number.isSafeInteger(at) || at < 0 ||
          (afterId && !/^[A-Za-z0-9_-]{1,140}$/.test(afterId)) ||
          (at > 0 && !afterId) || (afterId && at === 0)) {
        return res.status(400).json({ code: 'invalid_activity_cursor' });
      }
      const { FieldPath } = await import('firebase-admin/firestore');
      const PAGE_SIZE = 200;
      const settings = await firestore.collection('artifacts').doc(appId).collection('public').doc('data').collection('room_settings').doc('2o3a').get();
      const statisticsResetAt = Number(settings.data()?.statisticsResetAt || 0);
      let query = events.where('at', '>', statisticsResetAt).orderBy('at', 'asc')
        .orderBy(FieldPath.documentId(), 'asc');
      if (afterId) query = query.startAfter(at, afterId);
      const snapshot = await query.limit(PAGE_SIZE).get();
      const rows = snapshot.docs.map(entry =>
        normalizeActivityEvent({ ...entry.data(), id: entry.id })).filter(event => event && event.at > statisticsResetAt);
      const last = snapshot.docs[snapshot.docs.length - 1];
      const nextCursor = last
        ? { at: Number(last.get('at')) || 0, id: last.id } : null;
      return res.status(200).json({
        events: rows, nextCursor, hasMore: snapshot.size === PAGE_SIZE, statisticsResetAt,
      });
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
    // A quota-exhausted project must not trigger rapid, full-history retries
    // from every open moderator tab. Tell callers to back off explicitly.
    const diagnostic = String(error?.code || '') + ' ' + String(error?.message || '');
    if (/RESOURCE_EXHAUSTED|Quota exceeded|\\b8\\b/i.test(diagnostic)) {
      res.setHeader('Retry-After', '3600');
      console.warn('Activity log Firestore quota exhausted; client backoff requested.');
      return res.status(503).json({
        code: 'firestore_quota_exceeded',
        error: 'Activity history is temporarily unavailable due to Firestore quota.',
      });
    }
    console.error('Activity log API failed:', error?.message || error);
    return res.status(503).json({
      code: 'activity_storage_unavailable',
      error: 'Activity log storage is temporarily unavailable.',
    });
  }
}
