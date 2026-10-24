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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return res.status(500).send('Twitch OAuth is not configured: set TWITCH_CLIENT_ID in Vercel.');
  const origin = process.env.TWITCH_APP_URL || `https://${req.headers.host}`;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${origin}/api/twitch/callback`;
  // This optional permission upgrade is available only to the already
  // verified moderator. The streamer signs in with ordinary profile scopes.
  const chatSetup = String(req.query?.chat_setup || '') === '1';
  if (chatSetup) {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => {
      const index = item.indexOf('=');
      return index > 0 ? [item.slice(0, index).trim(), item.slice(index + 1).trim()] : ['', ''];
    }).filter(item => item[0]));
    const token = cookies.yedi_twitch_access || '';
    if (!token) return res.status(403).send('Sign in as paim_beach_pete before authorizing Twitch chat intake.');
    try {
      const verify = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: 'OAuth ' + decodeURIComponent(token) },
        signal: AbortSignal.timeout(6000), cache: 'no-store',
      });
      const data = verify.ok ? await verify.json() : null;
      if (data?.client_id !== clientId || String(data?.login || '').toLowerCase() !== 'paim_beach_pete') {
        return res.status(403).send('Twitch chat intake can only be authorized by paim_beach_pete.');
      }
    } catch { return res.status(503).send('Could not verify moderator authorization.'); }
  }
  const state = randomBytes(32).toString('hex');
  setStateCookie(res, req, state, 600);
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: chatSetup ? 'user:read:email user:read:chat user:bot' : 'user:read:email',
    state, ...(chatSetup ? { force_verify: 'true' } : {}),
  });
  res.redirect(302, `https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
}
