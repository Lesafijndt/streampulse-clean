import { randomBytes } from 'node:crypto';

function isHttpsRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return process.env.NODE_ENV === 'production' || forwardedProto === 'https' || host.endsWith('.vercel.app');
}

function setStateCookie(res, req, value, maxAge = 600) {
  const secure = isHttpsRequest(req);
  // OAuth state is created immediately before leaving for Twitch. None+Secure avoids
  // Chromium dropping this short-lived cookie in cross-site 302 redirect chains.
  const sameSite = secure ? 'None; Secure' : 'Lax';
  res.setHeader('Set-Cookie', `yedi_twitch_oauth_state=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`);
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');
  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;
  const state = randomBytes(32).toString('hex');
  setStateCookie(res, req, state, 600);
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'user:read:email channel:bot', state });
  res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}
