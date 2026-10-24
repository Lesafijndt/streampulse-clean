const CHAT_BOT_LOGIN = 'gachibot69';
const ALLOWED_STAFF_LOGINS = new Set(['paim_beach_pete']);

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
function appendCookie(res, cookieValue) {
  const previous = res.getHeader('Set-Cookie');
  const current = previous ? (Array.isArray(previous) ? previous : [previous]) : [];
  res.setHeader('Set-Cookie', [...current, cookieValue]);
}
function setBotCookie(res, name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
function clearBotCookies(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_bot_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_bot_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function clearStaffCookies(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `yedi_twitch_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  appendCookie(res, `yedi_twitch_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
async function validateToken(accessToken) {
  const response = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
  if (!response.ok) return null;
  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  if (!clientId) return res.status(500).json({ error: 'Twitch OAuth is not configured.' });

  // Require the private dashboard login as well as the dedicated bot login.
  // The bot account alone must not expose an arbitrary chat-send endpoint.
  if (!cookies.yedi_twitch_access) return res.status(401).json({ error: 'Sign in to Yedi Hub as 2o3a or paim_beach_pete first.' });
  if (!cookies.yedi_twitch_bot_access) return res.status(401).json({ error: 'Connect the Twitch chat bot account @gachibot69 first.' });

  // The API sends only to the configured Yedi Hub origin and rejects missing/cross-origin browser origins.
  try {
    const configuredOrigin = new URL(process.env.TWITCH_APP_URL || `https://${req.headers.host}`).origin;
    const requestOrigin = req.headers.origin;
    if (requestOrigin !== configuredOrigin) return res.status(403).json({ error: 'Chat messages must originate from the Yedi Hub site.' });
  } catch {
    return res.status(500).json({ error: 'The Twitch app origin is not configured correctly.' });
  }

  const { message: rawMessage } = parseBody(req.body);
  const message = String(rawMessage || '').trim();
  if (!message || message.length > 450) return res.status(400).json({ error: 'Message must contain 1–450 characters.' });

  try {
    let staffToken = cookies.yedi_twitch_access;
    let staffValidation = await validateToken(staffToken);
    if (!staffValidation && cookies.yedi_twitch_refresh && clientSecret) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cookies.yedi_twitch_refresh, client_id: clientId, client_secret: clientSecret })
      });
      const refreshedStaff = await refreshResponse.json();
      if (refreshResponse.ok && refreshedStaff.access_token) {
        staffToken = refreshedStaff.access_token;
        setBotCookie(res, 'yedi_twitch_access', refreshedStaff.access_token, Math.min(Number(refreshedStaff.expires_in) || 14400, 14400));
        if (refreshedStaff.refresh_token) setBotCookie(res, 'yedi_twitch_refresh', refreshedStaff.refresh_token, 60 * 60 * 24 * 30);
        staffValidation = await validateToken(staffToken);
      } else {
        clearStaffCookies(res);
        return res.status(401).json({ error: 'Your Yedi Hub staff session expired. Sign in again as 2o3a or paim_beach_pete.' });
      }
    }
    const staffLogin = String(staffValidation?.login || '').toLowerCase();
    if (!staffValidation || staffValidation.client_id !== clientId || !ALLOWED_STAFF_LOGINS.has(staffLogin)) {
      clearStaffCookies(res);
      return res.status(401).json({ error: 'Your Yedi Hub staff session expired. Sign in again as 2o3a or paim_beach_pete.' });
    }

    let accessToken = cookies.yedi_twitch_bot_access;
    let validation = await validateToken(accessToken);
    if (!validation && cookies.yedi_twitch_bot_refresh && clientSecret) {
      const refreshResponse = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cookies.yedi_twitch_bot_refresh, client_id: clientId, client_secret: clientSecret })
      });
      const refreshed = await refreshResponse.json();
      if (refreshResponse.ok && refreshed.access_token) {
        accessToken = refreshed.access_token;
        setBotCookie(res, 'yedi_twitch_bot_access', refreshed.access_token, Math.min(Number(refreshed.expires_in) || 14400, 14400));
        if (refreshed.refresh_token) setBotCookie(res, 'yedi_twitch_bot_refresh', refreshed.refresh_token, 60 * 60 * 24 * 30);
        validation = await validateToken(accessToken);
      } else {
        clearBotCookies(res);
        return res.status(401).json({ error: 'Chat bot session expired. Reconnect @gachibot69.' });
      }
    }

    const scopes = Array.isArray(validation?.scopes) ? validation.scopes : [];
    if (!validation || validation.client_id !== clientId || String(validation.login || '').toLowerCase() !== CHAT_BOT_LOGIN) {
      clearBotCookies(res);
      return res.status(401).json({ error: 'Chat bot session expired or belongs to a different account. Reconnect @gachibot69.' });
    }
    if (!scopes.includes('user:write:chat')) {
      return res.status(403).json({ error: 'The @gachibot69 account has not granted Twitch chat-write permission. Reconnect the bot and approve it.' });
    }

    const broadcasterResponse = await fetch('https://api.twitch.tv/helix/users?login=2o3a', {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${accessToken}` }
    });
    if (!broadcasterResponse.ok) return res.status(502).json({ error: 'Could not resolve Twitch channel 2o3a.' });
    const broadcaster = (await broadcasterResponse.json()).data?.[0];
    if (!broadcaster?.id) return res.status(502).json({ error: 'Could not resolve Twitch channel 2o3a.' });

    const sendResponse = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ broadcaster_id: String(broadcaster.id), sender_id: String(validation.user_id), message })
    });
    const result = await sendResponse.json().catch(() => ({}));
    if (!sendResponse.ok) {
      const reason = String(result.message || 'Twitch declined the chat message. Check that gachibot69 can chat in 2o3a’s channel.');
      return res.status(sendResponse.status === 429 ? 429 : (sendResponse.status >= 500 ? 502 : sendResponse.status)).json({ error: reason });
    }
    const outcome = Array.isArray(result.data) ? result.data[0] : null;
    if (outcome && outcome.is_sent === false) {
      return res.status(502).json({ error: outcome.drop_reason?.message || 'Twitch did not send the chat message. Check that gachibot69 can chat in 2o3a’s channel.' });
    }
    return res.status(200).json({ ok: true, data: result.data || [] });
  } catch (error) {
    console.error('Twitch bot chat message send failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not send a message as @gachibot69.' });
  }
}
