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
function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return process.env.NODE_ENV === 'production' || forwardedProto === 'https' || host.endsWith('.vercel.app');
}
function setCookie(res, req, name, value, maxAge, sameSite = 'Lax') {
  const secure = isHttpsRequest(req);
  const site = sameSite === 'None' && !secure ? 'Lax' : sameSite;
  const secureAttribute = secure ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${site}; Max-Age=${maxAge}${secureAttribute}`);
}
function clearAuthCookies(res, req) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const cookies = parseCookies(req.headers.cookie);
  const state = String(req.query.state || '');
  if (!state || state !== cookies.yedi_twitch_oauth_state) return res.status(400).send('OAuth state check failed. Please retry login.');
  setCookie(res, req, 'yedi_twitch_oauth_state', '', 0, 'None');
  if (req.query.error) return res.redirect(302, `/?twitch_error=${encodeURIComponent(String(req.query.error))}`);

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !req.query.code) return res.status(500).send('Twitch OAuth is not configured correctly.');
  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;

  try {
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: String(req.query.code), grant_type: 'authorization_code', redirect_uri: redirectUri })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) return res.status(502).send('Twitch token exchange failed. Check the Twitch redirect URL and client secret.');

    const meResponse = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${token.access_token}` }
    });
    if (!meResponse.ok) return res.status(502).send('Twitch could not verify the signed-in account.');
    const me = (await meResponse.json()).data?.[0];
    const login = String(me?.login || '').toLowerCase();
    if (!me || !Object.hasOwn(ALLOWED_ROLES, login)) {
      clearAuthCookies(res, req);
      return res.redirect(302, '/?twitch_error=unauthorized');
    }

    setCookie(res, req, 'yedi_twitch_access', token.access_token, Math.min(Number(token.expires_in) || 14400, 14400));
    if (token.refresh_token) setCookie(res, req, 'yedi_twitch_refresh', token.refresh_token, 60 * 60 * 24 * 30);
    else setCookie(res, req, 'yedi_twitch_refresh', '', 0);
    return res.redirect(302, '/');
  } catch (error) {
    console.error('Twitch OAuth callback failed:', error);
    clearAuthCookies(res);
    return res.status(502).send('Could not connect to Twitch. Please try signing in again.');
  }
}
