const BOT_LOGIN = 'gachibot69';
const REMEMBERED_SESSION_MAX_AGE = 60 * 60 * 24 * 400;

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
function clearBotCookies(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_bot_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_bot_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function replyUnauthenticated(res) {
  return res.status(200).json({ connected: false, user: null });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  if (!clientId || (!cookies.yedi_twitch_bot_access && !cookies.yedi_twitch_bot_refresh)) return replyUnauthenticated(res);

  try {
    // A refresh cookie can restore the bot session when the short-lived access
    // cookie expired while the browser was closed.
    let accessToken = cookies.yedi_twitch_bot_access || '';
    let refreshToken = cookies.yedi_twitch_bot_refresh || '';
    let validationResponse = accessToken
      ? await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } })
      : null;
    let validation = validationResponse?.ok ? await validationResponse.json() : null;

    if (!validation && refreshToken && clientSecret) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
      });
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok || !refreshed.access_token) {
        clearBotCookies(res);
        return replyUnauthenticated(res);
      }
      accessToken = refreshed.access_token;
      if (refreshed.refresh_token) refreshToken = refreshed.refresh_token;
      validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
      validation = validationResponse.ok ? await validationResponse.json() : null;
    }

    const scopes = Array.isArray(validation?.scopes) ? validation.scopes : [];
    if (!validation || validation.client_id !== clientId || String(validation.login || '').toLowerCase() !== BOT_LOGIN || !scopes.includes('user:write:chat')) {
      clearBotCookies(res);
      return replyUnauthenticated(res);
    }
    const accessCookieMaxAge = Math.max(1, Math.min(Number(validation.expires_in) || 14400, 14400));
    setCookie(res, 'yedi_twitch_bot_access', accessToken, accessCookieMaxAge);
    if (refreshToken) setCookie(res, 'yedi_twitch_bot_refresh', refreshToken, REMEMBERED_SESSION_MAX_AGE);
    return res.status(200).json({ connected: true, user: { id: String(validation.user_id), login: BOT_LOGIN } });
  } catch (error) {
    console.error('Twitch chat bot session check failed:', error?.message || error);
    return replyUnauthenticated(res);
  }
}
