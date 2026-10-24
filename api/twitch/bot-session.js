const BOT_LOGIN = 'gachibot69';
// Preserve exact request bytes for Twitch's HMAC verification. This route also
// hosts the existing moderator WebSocket subscription within the Hobby limit.
export const config = { api: { bodyParser: false } };

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
  const action = String(req.query?.action || '');
  if (action === 'logout') {
    const { default: logout } = await import('../../server/bot-logout.js');
    return logout(req, res);
  }
  if (req.method === 'POST' && action === 'webhook') {
    const { default: webhook } = await import('../../server/twitch-webhook.js');
    return webhook(req, res);
  }
  if ((req.method === 'POST' && action === 'webhook-setup') ||
      (req.method === 'GET' && action === 'webhook-status')) {
    const { default: configure } = await import('../../server/twitch-webhook-setup.js');
    return configure(req, res, { statusOnly: action === 'webhook-status' });
  }
  // Keep EventSub subscription setup within the already-deployed bot-session
  // serverless function. Vercel Hobby only permits 12 API functions.
  if (req.method === 'POST' && String(req.query?.action || '') === 'subscribe') {
    const { default: subscribeChat } = await import('../../server/chat-subscribe.js');
    return subscribeChat(req, res);
  }
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Chat bot controls are IT-only: require a verified moderator login, not
  // merely a bot OAuth cookie or an untrusted client role.
  const moderatorCookie = parseCookies(req.headers.cookie).yedi_twitch_access;
  if (!moderatorCookie) return res.status(403).json({ connected: false, code: 'moderator_required' });
  try {
    const result = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + moderatorCookie },
      signal: AbortSignal.timeout(5000),
    });
    const verified = result.ok ? await result.json() : null;
    if (verified?.client_id !== process.env.TWITCH_CLIENT_ID ||
        String(verified?.login || '').toLowerCase() !== 'paim_beach_pete') {
      return res.status(403).json({ connected: false, code: 'moderator_required' });
    }
  } catch { return res.status(503).json({ connected: false, code: 'authorization_unavailable' }); }
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
    return res.status(200).json({
      connected: true,
      canReadChat: scopes.includes('user:read:chat'),
      user: { id: String(validation.user_id), login: BOT_LOGIN },
    });
  } catch (error) {
    console.error('Twitch chat bot session check failed:', error?.message || error);
    return replyUnauthenticated(res);
  }
}
