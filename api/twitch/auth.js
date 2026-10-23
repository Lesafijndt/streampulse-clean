import { randomBytes } from 'node:crypto';

function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return process.env.NODE_ENV === 'production' || forwardedProto === 'https' || host.endsWith('.vercel.app');
}

function setStaffStateCookie(res, req, value, maxAge = 600) {
  const secure = isHttpsRequest(req);
  const sameSite = secure ? 'None; Secure' : 'Lax';
  res.setHeader('Set-Cookie', `yedi_twitch_oauth_state=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`);
}

function staffLogin(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');
  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;
  const state = randomBytes(32).toString('hex');
  setStaffStateCookie(res, req, state, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:email channel:bot',
    state,
  });
  return res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}

function staffLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `yedi_twitch_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
  return res.status(200).json({ ok: true });
}

function setBotCookie(res, name, value, maxAge = 600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function botLogin(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');
  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;
  const state = randomBytes(32).toString('hex');
  setBotCookie(res, 'yedi_twitch_bot_oauth_state', state, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:chat user:write:chat user:bot',
    state,
    force_verify: 'true',
  });
  return res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}

function botLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `yedi_twitch_bot_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_bot_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_bot_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
  return res.status(200).json({ ok: true });
}

const HANDLERS = Object.freeze({
  login: staffLogin,
  logout: staffLogout,
  'bot-login': botLogin,
  'bot-logout': botLogout,
  'public-request': async (req, res) => {
    const { default: publicRequestHandler } = await import('../_lib/public-request-handler.js');
    return publicRequestHandler(req, res);
  },
});

export const SUPPORTED_TWITCH_AUTH_ACTIONS = Object.freeze(Object.keys(HANDLERS));

export function getTwitchAuthAction(req) {
  const value = req?.query?.action;
  return String(Array.isArray(value) ? value[0] || '' : value || '');
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const action = getTwitchAuthAction(req);
  const selected = HANDLERS[action];
  if (!selected) return res.status(404).json({ error: 'Unknown Twitch auth action.' });
  return selected(req, res);
}
