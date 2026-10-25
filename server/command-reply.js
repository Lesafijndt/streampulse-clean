let cached;
export async function sendCommandReply(message, request = fetch) {
  const clientId = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !secret) return { sent: false, code: 'twitch_app_not_configured' };
  try {
    let session = request === fetch ? cached : null;
    if (!session || session.clientId !== clientId || session.until < Date.now()) {
      const response = await request('https://id.twitch.tv/oauth2/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(5000) });
      const token = await response.json();
      if (!response.ok || !token.access_token) return { sent: false, code: 'chat_app_token_failed' };
      const headers = { 'Client-Id': clientId, Authorization: 'Bearer ' + token.access_token };
      const users = await request('https://api.twitch.tv/helix/users?login=2o3a&login=gachibot69', { headers, signal: AbortSignal.timeout(5000) });
      const rows = (await users.json()).data || [];
      session = { clientId, headers, broadcaster: rows.find(user => user.login === '2o3a')?.id,
        sender: rows.find(user => user.login === 'gachibot69')?.id, until: Date.now() + Math.max(0, Number(token.expires_in || 0) - 60) * 1000 };
      if (!users.ok || !session.sender || !session.broadcaster) return { sent: false, code: 'chat_id_lookup_failed' };
      if (request === fetch) cached = session;
    }
    const response = await request('https://api.twitch.tv/helix/chat/messages', { method: 'POST',
      headers: { ...session.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_id: String(session.broadcaster), sender_id: String(session.sender),
        message: Array.from(String(message).replace(/\s+/g, ' ').trim()).slice(0, 450).join(''), for_source_only: true }), signal: AbortSignal.timeout(5000) });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.data?.[0]?.is_sent === true) return { sent: true };
    if (response.status === 401) cached = null;
    return { sent: false, code: [401, 403].includes(response.status) ? 'bot_chat_grant_required' : response.status === 429 ? 'chat_rate_limited' : 'chat_reply_failed' };
  } catch { return { sent: false, code: 'chat_reply_unavailable' }; }
}
