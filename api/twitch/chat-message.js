const ALLOWED_ROLES = Object.freeze({ '2o3a': 'streamer', 'paim_beach_pete': 'moderator' });

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map((value) => value.trim()).filter(Boolean).map((value) => {
    const index = value.indexOf('=');
    try { return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))]; }
    catch { return [value.slice(0, index), '']; }
  }));
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string') return {};
  try { return JSON.parse(body); } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.TWITCH_CLIENT_ID;
  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies.yedi_twitch_access;
  if (!clientId || !accessToken) return res.status(401).json({ error: 'Sign in to Twitch first.' });

  // Require same-origin browser requests. The access token itself is never accepted from the request body.
  const configuredOrigin = process.env.TWITCH_APP_URL ? new URL(process.env.TWITCH_APP_URL).origin : `https://${req.headers.host}`;
  const requestOrigin = req.headers.origin;
  if (requestOrigin && requestOrigin !== configuredOrigin) return res.status(403).json({ error: 'Cross-origin chat requests are not allowed.' });

  const { message: rawMessage } = parseBody(req.body);
  const message = String(rawMessage || '').trim();
  if (!message || message.length > 450) return res.status(400).json({ error: 'Message must contain 1–450 characters.' });

  try {
    const validationResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` }
    });
    const validation = validationResponse.ok ? await validationResponse.json() : null;
    const login = String(validation?.login || '').toLowerCase();
    if (!validation || validation.client_id !== clientId || !ALLOWED_ROLES[login]) {
      return res.status(401).json({ error: 'Your Twitch session expired. Please sign in again.' });
    }
    const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
    if (!scopes.includes('user:write:chat')) {
      return res.status(403).json({ error: 'Twitch chat write permission is missing. Log out and sign in again to authorize it.' });
    }

    // Resolve the fixed Yedi Hub channel; never accept a destination channel from the browser.
    const broadcasterResponse = await fetch('https://api.twitch.tv/helix/users?login=2o3a', {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` }
    });
    if (!broadcasterResponse.ok) return res.status(502).json({ error: 'Could not resolve the configured Twitch channel.' });
    const broadcaster = (await broadcasterResponse.json()).data?.[0];
    if (!broadcaster?.id) return res.status(502).json({ error: 'Could not resolve the configured Twitch channel.' });

    const sendResponse = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: String(broadcaster.id),
        sender_id: String(validation.user_id),
        message
      })
    });
    const result = await sendResponse.json().catch(() => ({}));
    if (!sendResponse.ok) {
      const reason = String(result.message || 'Twitch declined the chat message.');
      return res.status(sendResponse.status === 429 ? 429 : (sendResponse.status >= 500 ? 502 : sendResponse.status))
        .json({ error: reason });
    }
    return res.status(200).json({ ok: true, data: result.data || [] });
  } catch (error) {
    console.error('Twitch chat message send failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not send a message to Twitch chat.' });
  }
}
