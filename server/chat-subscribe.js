// Moderator-only Twitch EventSub WebSocket subscription. The bot access
// token remains in HttpOnly cookies and never enters the browser WebSocket.
const MODERATOR = 'paim_beach_pete';
const BOT = 'gachibot69';

function cookiesFrom(header = '') {
  const entries = String(header).split(';').map(x => x.trim()).filter(Boolean).map(item => {
    const i = item.indexOf('=');
    if (i < 1) return null;
    try { return [item.slice(0, i), decodeURIComponent(item.slice(i + 1))]; }
    catch { return [item.slice(0, i), '']; }
  }).filter(Boolean);
  return Object.fromEntries(entries);
}

function appendCookie(res, name, value, seconds) {
  const previous = res.getHeader('Set-Cookie');
  const all = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    ...all,
    name + '=' + encodeURIComponent(value) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + seconds + secure,
  ]);
}

async function validate(token) {
  if (!token) return null;
  const response = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + token },
    signal: AbortSignal.timeout(5000),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return response.json();
}

export async function obtainSession(req, res, kind) {
  const data = cookiesFrom(req.headers.cookie);
  const prefix = kind === 'bot' ? 'yedi_twitch_bot_' : 'yedi_twitch_';
  const clientId = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  let access = data[prefix + 'access'] || '';
  let refresh = data[prefix + 'refresh'] || '';
  let identity = await validate(access);
  if (!identity && refresh && secret) {
    const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refresh,
        client_id: clientId, client_secret: secret,
      }),
      signal: AbortSignal.timeout(7000), cache: 'no-store',
    });
    const updated = await refreshResponse.json().catch(() => ({}));
    if (refreshResponse.ok && updated.access_token) {
      access = updated.access_token;
      refresh = updated.refresh_token || refresh;
      identity = await validate(access);
      if (identity) {
        appendCookie(res, prefix + 'access', access, Math.max(1, Math.min(Number(identity.expires_in) || 14400, 14400)));
        if (refresh) appendCookie(res, prefix + 'refresh', refresh, 60 * 60 * 24 * 30);
      }
    }
  }
  if (!identity || identity.client_id !== clientId) return null;
  const login = String(identity.login || '').toLowerCase();
  const expected = kind === 'bot' ? BOT : MODERATOR;
  if (login !== expected) return null;
  return {
    login, userId: String(identity.user_id || ''),
    scopes: Array.isArray(identity.scopes) ? identity.scopes : [],
    access,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method_not_allowed' });
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host || String(req.headers.origin || '') !== protocol + '://' + host) {
    return res.status(403).json({ ok: false, code: 'origin_denied' });
  }
  // This endpoint shares a raw-body API function with the signed webhook.
  const { readTwitchRawBody } = await import('./twitch-webhook.js');
  const raw = await readTwitchRawBody(req).catch(() => Buffer.alloc(0));
  const body = (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return {}; } })();
  const sessionId = String(body.sessionId || '');
  if (!/^[A-Za-z0-9_-]{12,256}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, code: 'invalid_websocket_session' });
  }
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    return res.status(503).json({ ok: false, code: 'twitch_config_missing' });
  }
  try {
    const staff = await obtainSession(req, res, 'staff');
    if (!staff) return res.status(401).json({ ok: false, code: 'moderator_login_required' });
    const bot = await obtainSession(req, res, 'bot');
    if (!bot) return res.status(401).json({ ok: false, code: 'bot_login_required' });
    if (!bot.scopes.includes('user:read:chat')) {
      return res.status(403).json({ ok: false, code: 'bot_read_scope_missing' });
    }

    const headers = {
      'Client-Id': process.env.TWITCH_CLIENT_ID,
      Authorization: 'Bearer ' + bot.access,
    };
    const broadcasterResponse = await fetch('https://api.twitch.tv/helix/users?login=2o3a', {
      headers, cache: 'no-store', signal: AbortSignal.timeout(6000),
    });
    const broadcasterResult = await broadcasterResponse.json().catch(() => ({}));
    const broadcasterId = String(broadcasterResult.data?.[0]?.id || '');
    if (!broadcasterResponse.ok || !broadcasterId) {
      return res.status(502).json({ ok: false, code: 'broadcaster_lookup_failed' });
    }
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: bot.userId },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('Twitch EventSub WebSocket subscription declined:', response.status, String(data.message || '').slice(0, 160));
      return res.status(response.status === 403 ? 403 : 502).json({
        ok: false,
        code: response.status === 403 ? 'twitch_chat_permission_denied' :
          response.status === 429 ? 'twitch_subscription_rate_limited' : 'twitch_subscription_failed',
      });
    }
    return res.status(201).json({ ok: true, subscriptionStatus: data.data?.[0]?.status || 'enabled' });
  } catch (error) {
    console.error('Twitch chat WebSocket setup failed:', String(error?.message || error).slice(0, 200));
    return res.status(503).json({ ok: false, code: 'twitch_chat_setup_unavailable' });
  }
}
