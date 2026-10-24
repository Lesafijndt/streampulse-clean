import { randomBytes } from 'node:crypto';

function setCookie(res, name, value, maxAge = 600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');

  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  // Re-use the already registered callback URI; a separate, HttpOnly state cookie distinguishes this flow.
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;
  const state = randomBytes(32).toString('hex');
  setCookie(res, 'yedi_twitch_bot_oauth_state', state, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:chat user:write:chat',
    state,
    force_verify: 'true'
  });
  res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}
