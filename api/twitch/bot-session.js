const BOT_LOGIN = 'gachibot69';

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
  if (!clientId || !cookies.yedi_twitch_bot_access) return replyUnauthenticated(res);

  try {
    let accessToken = cookies.yedi_twitch_bot_access;
    let validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
    let validation = validationResponse.ok ? await validationResponse.json() : null;

    if (!validation && cookies.yedi_twitch_bot_refresh && clientSecret) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cookies.yedi_twitch_bot_refresh, client_id: clientId, client_secret: clientSecret })
      });
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok || !refreshed.access_token) {
        clearBotCookies(res);
        return replyUnauthenticated(res);
      }
      accessToken = refreshed.access_token;
      setCookie(res, 'yedi_twitch_bot_access', refreshed.access_token, Math.min(Number(refreshed.expires_in) || 14400, 14400));
      if (refreshed.refresh_token) setCookie(res, 'yedi_twitch_bot_refresh', refreshed.refresh_token, 60 * 60 * 24 * 30);
      validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
      validation = validationResponse.ok ? await validationResponse.json() : null;
    }

    const scopes = Array.isArray(validation?.scopes) ? validation.scopes : [];
    if (!validation || validation.client_id !== clientId || String(validation.login || '').toLowerCase() !== BOT_LOGIN || !scopes.includes('user:write:chat')) {
      clearBotCookies(res);
      return replyUnauthenticated(res);
    }
    return res.status(200).json({ connected: true, user: { id: String(validation.user_id), login: BOT_LOGIN } });
  } catch (error) {
    console.error('Twitch chat bot session check failed:', error?.message || error);
    return replyUnauthenticated(res);
  }
}
