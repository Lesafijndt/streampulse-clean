const ALLOWED_ROLES = Object.freeze({ '2o3a': 'streamer', 'paim_beach_pete': 'moderator' });

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
function unauthenticated(res) {
  return res.status(200).json({ authenticated: false, role: 'viewer', user: null });
}
async function getFirebaseAdminAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  // Load Firebase Admin lazily so a startup/module-loading issue cannot crash
  // the entire Twitch session endpoint before its handler runs.
  const [{ cert, getApps, initializeApp }, { getAuth: getAdminAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth')
  ]);
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); } catch {
    try { serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON'); }
  }
  const appName = 'yedi-hub-firebase-admin';
  const app = getApps().find(item => item.name === appName) || initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id }, appName);
  return getAdminAuth(app);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const cookies = parseCookies(req.headers.cookie);
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId || !cookies.yedi_twitch_access) return unauthenticated(res);

  try {
    let accessToken = cookies.yedi_twitch_access;
    let validation = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
    let validationBody = validation.ok ? await validation.json() : null;

    // Refresh an expired/revoked access token only when Twitch still accepts the refresh token.
    if (!validation.ok && cookies.yedi_twitch_refresh && process.env.TWITCH_CLIENT_SECRET) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cookies.yedi_twitch_refresh, client_id: clientId, client_secret: process.env.TWITCH_CLIENT_SECRET })
      });
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok || !refreshed.access_token) {
        clearAuthCookies(res);
        return unauthenticated(res);
      }
      accessToken = refreshed.access_token;
      setCookie(res, 'yedi_twitch_access', refreshed.access_token, Math.min(Number(refreshed.expires_in) || 14400, 14400));
      if (refreshed.refresh_token) setCookie(res, 'yedi_twitch_refresh', refreshed.refresh_token, 60 * 60 * 24 * 30);
      validation = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
      validationBody = validation.ok ? await validation.json() : null;
    }

    if (!validation.ok || !validationBody?.login) {
      clearAuthCookies(res);
      return unauthenticated(res);
    }
    if (validationBody.client_id !== clientId) {
      clearAuthCookies(res);
      return unauthenticated(res);
    }

    const meResponse = await fetch('https://api.twitch.tv/helix/users', { headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` } });
    if (!meResponse.ok) return unauthenticated(res);
    const me = (await meResponse.json()).data?.[0];
    const login = String(me?.login || '').toLowerCase();
    const role = ALLOWED_ROLES[login];
    if (!me || !role || String(validationBody.login).toLowerCase() !== login || String(validationBody.user_id) !== String(me.id)) {
      clearAuthCookies(res);
      return unauthenticated(res);
    }

    let firebaseCustomToken = '';
    let firebaseTokenReady = false;
    try {
      const adminAuth = await getFirebaseAdminAuth();
      firebaseCustomToken = await adminAuth.createCustomToken(`twitch_${me.id}`, {
        yediAuthorized: true,
        twitchLogin: login,
        role
      });
      firebaseTokenReady = true;
    } catch (error) {
      // Twitch login still works in browser-local mode, but Firestore stays locked without this secret.
      console.error('Could not create Firebase custom token:', error?.message || error);
    }

    return res.status(200).json({
      authenticated: true,
      role,
      firebaseTokenReady,
      ...(firebaseCustomToken ? { firebaseCustomToken } : {}),
      user: { id: me.id, login: me.login, display_name: me.display_name, profile_image_url: me.profile_image_url || '' },
      channel: '2o3a'
    });
  } catch (error) {
    console.error('Twitch session verification failed:', error?.message || error);
    return unauthenticated(res);
  }
}
