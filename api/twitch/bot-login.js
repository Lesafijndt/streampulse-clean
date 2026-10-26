import { requestRedirectUri } from '../../server/app-origin.js';
import { randomBytes } from 'node:crypto';

function setCookie(res, name, value, maxAge = 600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  // Only the moderator may connect or reauthorize the bot account.
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';')
    .map(x => x.trim()).filter(Boolean).map(x => {
      const at = x.indexOf('=');
      try { return [x.slice(0, at), decodeURIComponent(x.slice(at + 1))]; }
      catch { return [x.slice(0, at), '']; }
    }));
  if (!cookies.yedi_twitch_access) return res.status(403).send('Moderator required');
  let verified;
  try {
    const auth = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + cookies.yedi_twitch_access },
      signal: AbortSignal.timeout(5000),
    });
    verified = auth.ok ? await auth.json() : null;
  } catch { return res.status(503).send('Cannot verify moderator session'); }
  if (String(verified?.login || '').toLowerCase() !== 'paim_beach_pete' ||
      verified.client_id !== process.env.TWITCH_CLIENT_ID) {
    return res.status(403).send('Moderator required');
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');

  // Re-use the already registered callback URI; a separate, HttpOnly state cookie distinguishes this flow.
  const redirectUri = requestRedirectUri(req);
  const state = randomBytes(32).toString('hex');
  setCookie(res, 'yedi_twitch_bot_oauth_state', state, 600);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:chat user:bot user:write:chat',
    state,
    force_verify: 'true'
  });
  res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}
