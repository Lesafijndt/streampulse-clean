import { sanitizePersonalPreferences } from '../../src/personalPreferences.js';
import { decodeServiceAccount } from '../../server/firebase-guard.js';
const ALLOWED_ROLES = Object.freeze({ '2o3a': 'streamer', 'paim_beach_pete': 'moderator' });
// Sliding, HttpOnly remember-me cookie. Renewed on every successful session check.
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 400;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    try { return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))]; } catch { return [v.slice(0, i), '']; }
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
function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function unauthenticated(res, reason = 'not_authenticated') {
  // Safe diagnostic only: never return tokens, cookie values, client secrets, or Twitch responses.
  res.setHeader('X-Yedi-Auth-Diagnostic', reason);
  return res.status(200).json({ authenticated: false, role: 'viewer', user: null, authDiagnostic: reason });
}
async function getFirebaseAdminAuth() {
  // Load lazily so the Twitch session endpoint can still run if Firebase Admin
  // is missing from the deployed function bundle. Firebase token creation is optional.
  const [{ cert, getApps, initializeApp }, { getAuth: getAdminAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth')
  ]);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); } catch {
    try { serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON'); }
  }

  // Validate the key shape explicitly so configuration mistakes are reported as a
  // useful safe category instead of the generic custom-token failure.
  if (!serviceAccount || typeof serviceAccount !== 'object' || Array.isArray(serviceAccount)) {
    throw new Error('Firebase service account must be a JSON object');
  }
  if (typeof serviceAccount.project_id !== 'string' || !serviceAccount.project_id.trim()) {
    throw new Error("Firebase service account is missing the 'project_id' field");
  }
  if (typeof serviceAccount.client_email !== 'string' || !serviceAccount.client_email.trim()) {
    throw new Error("Firebase service account is missing the 'client_email' field");
  }
  if (typeof serviceAccount.private_key !== 'string' || !serviceAccount.private_key.trim()) {
    throw new Error("Firebase service account is missing the 'private_key' field");
  }
  // Enforce the intended Firebase project before minting client tokens.
  serviceAccount = decodeServiceAccount(raw);

  const appName = 'yedi-hub-firebase-admin';
  const app = getApps().find(item => item.name === appName) || initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, appName);
  return getAdminAuth(app);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const preferencesAction = String(req.query?.action || '') === 'preferences';
  if (req.method === 'POST' && !preferencesAction) return res.status(405).json({ error: 'Method not allowed' });
  if (req.method === 'POST') {
    let allowedOrigin;
    try { allowedOrigin = new URL(process.env.TWITCH_APP_URL || 'https://' + req.headers.host).origin; }
    catch { return res.status(503).json({ code: 'origin_not_configured' }); }
    if (!req.headers.origin || req.headers.origin !== allowedOrigin) {
      return res.status(403).json({ code: 'origin_denied' });
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return unauthenticated(res, 'missing_twitch_client_id');
  if (!cookies.yedi_twitch_access && !cookies.yedi_twitch_refresh) {
    return unauthenticated(res, 'missing_session_cookies');
  }

  try {
    // Access cookies naturally expire with the short-lived Twitch token. A valid
    // refresh cookie must restore the session even when the access cookie is gone.
    let accessToken = cookies.yedi_twitch_access || '';
    let refreshToken = cookies.yedi_twitch_refresh || '';
    let validation = accessToken
      ? await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } })
      : null;
    let validationBody = validation?.ok ? await validation.json() : null;

    // Refresh an expired/missing access token while Twitch still accepts the refresh token.
    if ((!validation || !validation.ok) && refreshToken && process.env.TWITCH_CLIENT_SECRET) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: process.env.TWITCH_CLIENT_SECRET })
      });
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok || !refreshed.access_token) {
        clearAuthCookies(res);
        return unauthenticated(res, 'refresh_token_rejected');
      }
      accessToken = refreshed.access_token;
      if (refreshed.refresh_token) refreshToken = refreshed.refresh_token;
      validation = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
      validationBody = validation.ok ? await validation.json() : null;
    }

    if (!validation?.ok || !validationBody?.login) {
      clearAuthCookies(res);
      return unauthenticated(res, 'twitch_access_token_invalid');
    }
    if (validationBody.client_id !== clientId) {
      clearAuthCookies(res);
      return unauthenticated(res, 'token_client_id_mismatch');
    }

    const meResponse = await fetch('https://api.twitch.tv/helix/users', { headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` } });
    if (!meResponse.ok) return unauthenticated(res, 'twitch_user_lookup_failed');
    const me = (await meResponse.json()).data?.[0];
    const login = String(me?.login || '').toLowerCase();
    const role = ALLOWED_ROLES[login];
    if (!me || !role || String(validationBody.login).toLowerCase() !== login || String(validationBody.user_id) !== String(me.id)) {
      clearAuthCookies(res);
      return unauthenticated(res, 'account_not_allowlisted_or_token_identity_mismatch');
    }

    // Keep the access cookie no longer than its token's real remaining lifetime,
    // and roll the persistent refresh cookie forward on every successful visit.
    const accessCookieMaxAge = Math.max(1, Math.min(Number(validationBody.expires_in) || 14400, 14400));
    setCookie(res, 'yedi_twitch_access', accessToken, accessCookieMaxAge);
    if (refreshToken) setCookie(res, 'yedi_twitch_refresh', refreshToken, REMEMBERED_SESSION_MAX_AGE);

    if (preferencesAction) {
      // The document key is derived exclusively from the verified Twitch identity,
      // never from a request parameter. This route contains no admin diagnostics.
      try {
        await getFirebaseAdminAuth();
        const [{ getApps }, { getFirestore }] = await Promise.all([
          import('firebase-admin/app'), import('firebase-admin/firestore')
        ]);
        const firebase = getApps().find(app => app.name === 'yedi-hub-firebase-admin');
        if (!firebase) throw new Error('admin_not_initialized');
        const namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck';
        const ref = getFirestore(firebase).collection('artifacts').doc(namespace)
          .collection('public').doc('data').collection('user_profiles').doc(login);
        if (req.method === 'GET') {
          const snap = await ref.get();
          return res.status(200).json({
            ok: true, preferences: sanitizePersonalPreferences(snap.data()?.preferences || {})
          });
        }
        const body = typeof req.body === 'string'
          ? (req.body.length <= 8192 ? JSON.parse(req.body) : null) : req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            !body.preferences || typeof body.preferences !== 'object') {
          return res.status(400).json({ ok: false, code: 'invalid_preferences' });
        }
        const preferences = sanitizePersonalPreferences(body.preferences);
        await ref.set({ preferences, updatedAt: Date.now() }, { merge: true });
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('Personal preferences storage failed:', error?.code || error?.message || error);
        return res.status(503).json({ ok: false, code: 'preferences_storage_unavailable' });
      }
    }

    let firebaseCustomToken = '';
    let firebaseTokenReady = false;
    let firebaseDiagnostic = 'firebase_custom_token_failed';
    let firebaseDiagnosticCode = 'unknown_error';
    try {
      firebaseCustomToken = await (await getFirebaseAdminAuth()).createCustomToken(`twitch_${me.id}`, {
        yediAuthorized: true,
        twitchLogin: login,
        role
      });
      firebaseTokenReady = true;
      firebaseDiagnostic = 'ready';
    } catch (error) {
      // Keep the detailed error server-side; only send a non-sensitive diagnostic category to the browser.
      const message = String(error?.message || '');
      // Expose only a short safe error identifier to the browser, never raw server messages or credentials.
      firebaseDiagnosticCode = String(error?.code || error?.name || 'unknown_error')
        .toLowerCase()
        .replace(/[^a-z0-9/_-]/g, '')
        .slice(0, 64) || 'unknown_error';
      if (/FIREBASE_SERVICE_ACCOUNT_JSON is not configured/i.test(message)) {
        firebaseDiagnostic = 'missing_service_account';
      } else if (/not valid JSON or base64 JSON|must be a JSON object/i.test(message)) {
        firebaseDiagnostic = 'invalid_service_account_json';
      } else if (/missing the 'project_id' field/i.test(message)) {
        firebaseDiagnostic = 'service_account_missing_project_id';
      } else if (/missing the 'client_email' field/i.test(message)) {
        firebaseDiagnostic = 'service_account_missing_client_email';
      } else if (/missing the 'private_key' field/i.test(message)) {
        firebaseDiagnostic = 'service_account_missing_private_key';
      } else if (/private.?key|PEM|credential|invalid_grant|service account object|invalid jwt|signBlob|iam.serviceAccounts.signBlob/i.test(message)) {
        firebaseDiagnostic = 'invalid_service_account_credentials';
      } else if (/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) {
        firebaseDiagnostic = 'firebase_admin_sdk_unavailable';
      }
      console.error('Could not create Firebase custom token:', message || error);
    }

    return res.status(200).json({
      authenticated: true,
      role,
      firebaseTokenReady,
      // Only the moderator may inspect backend configuration diagnostics.
      ...(role === 'moderator'
        ? { firebaseDiagnostic, ...(firebaseTokenReady ? {} : { firebaseDiagnosticCode }) }
        : {}),
      ...(firebaseCustomToken ? { firebaseCustomToken } : {}),
      user: { id: me.id, login: me.login, display_name: me.display_name, profile_image_url: me.profile_image_url || '' },
      channel: '2o3a'
    });
  } catch (error) {
    console.error('Twitch session verification failed:', error?.message || error);
    return unauthenticated(res, 'session_verification_exception');
  }
}
