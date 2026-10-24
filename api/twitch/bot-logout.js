export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';')
    .map(x => x.trim()).filter(Boolean).map(x => {
      const at = x.indexOf('=');
      try { return [x.slice(0, at), decodeURIComponent(x.slice(at + 1))]; }
      catch { return [x.slice(0, at), '']; }
    }));
  if (!cookies.yedi_twitch_access) return res.status(403).json({ code: 'moderator_required' });
  try {
    const auth = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + cookies.yedi_twitch_access },
      signal: AbortSignal.timeout(5000),
    });
    const verified = auth.ok ? await auth.json() : null;
    if (String(verified?.login || '').toLowerCase() !== 'paim_beach_pete' ||
        verified?.client_id !== process.env.TWITCH_CLIENT_ID)
      return res.status(403).json({ code: 'moderator_required' });
  } catch { return res.status(503).json({ code: 'authorization_unavailable' }); }
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `yedi_twitch_bot_access=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_bot_refresh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `yedi_twitch_bot_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  ]);
  return res.status(200).json({ ok: true });
}
