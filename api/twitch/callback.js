const ALLOWED_ROLES = Object.freeze({ '2o3a': 'streamer', 'paim_beach_pete': 'moderator' });
const CHAT_BOT_LOGIN = 'gachibot69';

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
function clearCookies(res, names) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  for (const name of names) appendCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const cookies = parseCookies(req.headers.cookie);
  const state = String(req.query.state || '');
  const isBotFlow = Boolean(state && state === cookies.yedi_twitch_bot_oauth_state);
  const isStaffFlow = Boolean(state && state === cookies.yedi_twitch_oauth_state);
  if (!isBotFlow && !isStaffFlow) return res.status(400).send('OAuth state check failed. Please retry login.');
  clearCookies(res, [isBotFlow ? 'yedi_twitch_bot_oauth_state' : 'yedi_twitch_oauth_state']);

  if (req.query.error) {
    return res.redirect(302, isBotFlow
      ? `/?bot_error=${encodeURIComponent(String(req.query.error))}`
      : `/?twitch_error=${encodeURIComponent(String(req.query.error))}`);
  }

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

    // Bot and staff credentials are stored independently; logging the bot in never elevates its dashboard access.
    if (isBotFlow) {
      const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${token.access_token}` }
      });
      const validation = validationResponse.ok ? await validationResponse.json() : null;
      const login = String(validation?.login || '').toLowerCase();
      if (!validation || validation.client_id !== clientId || login !== CHAT_BOT_LOGIN) {
        clearCookies(res, ['yedi_twitch_bot_access', 'yedi_twitch_bot_refresh']);
        return res.redirect(302, '/?bot_error=wrong_account');
      }
      if (!Array.isArray(validation.scopes) || !validation.scopes.includes('user:write:chat')) {
        clearCookies(res, ['yedi_twitch_bot_access', 'yedi_twitch_bot_refresh']);
        return res.redirect(302, '/?bot_error=missing_scope');
      }
      setCookie(res, 'yedi_twitch_bot_access', token.access_token, Math.min(Number(token.expires_in) || 14400, 14400));
      if (token.refresh_token) setCookie(res, 'yedi_twitch_bot_refresh', token.refresh_token, 60 * 60 * 24 * 30);
      else setCookie(res, 'yedi_twitch_bot_refresh', '', 0);
      return res.redirect(302, '/?bot_connected=1');
    }

    const meResponse = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${token.access_token}` }
    });
    if (!meResponse.ok) return res.status(502).send('Twitch could not verify the signed-in account.');
    const me = (await meResponse.json()).data?.[0];
    const login = String(me?.login || '').toLowerCase();
    if (!me || !Object.hasOwn(ALLOWED_ROLES, login)) {
      clearCookies(res, ['yedi_twitch_access', 'yedi_twitch_refresh']);
      return res.redirect(302, '/?twitch_error=unauthorized');
    }

    setCookie(res, 'yedi_twitch_access', token.access_token, Math.min(Number(token.expires_in) || 14400, 14400));
    if (token.refresh_token) setCookie(res, 'yedi_twitch_refresh', token.refresh_token, 60 * 60 * 24 * 30);
    else setCookie(res, 'yedi_twitch_refresh', '', 0);
    return res.redirect(302, '/');
  } catch (error) {
    console.error('Twitch OAuth callback failed:', error);
    clearCookies(res, isBotFlow
      ? ['yedi_twitch_bot_access', 'yedi_twitch_bot_refresh']
      : ['yedi_twitch_access', 'yedi_twitch_refresh']);
    return res.status(502).send('Could not connect to Twitch. Please try signing in again.');
  }
}
