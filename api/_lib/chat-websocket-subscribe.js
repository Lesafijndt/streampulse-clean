import { loadUserSession } from '../twitch/eventsub-setup.js';

const MODERATOR = 'paim_beach_pete';
const BOT = 'gachibot69';

/** Moderator-only bridge between a Twitch EventSub WebSocket session and the
 * already authorized bot token. The token never leaves this server function. */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Cookie');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method_not_allowed' });
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host || String(req.headers.origin || '') !== proto + '://' + host) {
    return res.status(403).json({ ok: false, code: 'origin_not_allowed' });
  }
  const sessionId = String(req.body?.sessionId || '');
  if (!/^[a-zA-Z0-9_-]{15,256}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, code: 'invalid_websocket_session' });
  }
  try {
    const staff = await loadUserSession(req, res, 'staff');
    if (!staff.ok || staff.login !== MODERATOR) {
      return res.status(403).json({ ok: false, code: 'moderator_required' });
    }
    const bot = await loadUserSession(req, res, 'bot');
    if (!bot.ok || bot.login !== BOT || !bot.scopes.has('user:read:chat')) {
      return res.status(403).json({ ok: false, code: 'bot_reauthorization_required' });
    }
    const clientId = process.env.TWITCH_CLIENT_ID;
    const headers = { 'Client-Id': clientId, Authorization: 'Bearer ' + bot.token, 'Content-Type': 'application/json' };
    const usersResponse = await fetch('https://api.twitch.tv/helix/users?login=2o3a', {
      headers, signal: AbortSignal.timeout(4500), cache: 'no-store',
    });
    const users = await usersResponse.json().catch(() => ({}));
    const broadcasterId = String(users.data?.[0]?.id || '');
    if (!usersResponse.ok || !broadcasterId) {
      return res.status(502).json({ ok: false, code: 'broadcaster_lookup_failed' });
    }
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST', headers, cache: 'no-store', signal: AbortSignal.timeout(6500),
      body: JSON.stringify({
        type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: bot.userId },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('Moderator WebSocket subscription rejected:', response.status, String(result.message || '').slice(0, 180));
      return res.status(502).json({
        ok: false, code: response.status === 403 ? 'twitch_chat_permission_denied' : 'twitch_websocket_subscription_failed',
      });
    }
    return res.status(201).json({ ok: true, status: String(result.data?.[0]?.status || 'enabled') });
  } catch (error) {
    console.error('Moderator WebSocket setup error:', String(error?.message || error).slice(0, 250));
    return res.status(503).json({ ok: false, code: 'twitch_websocket_unavailable' });
  }
}
