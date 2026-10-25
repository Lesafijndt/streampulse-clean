let cachedToken = null;
export function normalizeClipPlayback(clip) {
  const offsetSeconds = Number(clip?.vod_offset), durationSeconds = Number(clip?.duration);
  if (!/^\d+$/.test(String(clip?.video_id || '')) || clip?.vod_offset == null ||
      !Number.isFinite(offsetSeconds) || offsetSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) {
    return { available: false, reason: 'source_video_unavailable' };
  }
  return { available: true, videoId: String(clip.video_id), offsetSeconds, durationSeconds };
}
export async function getClipPlayback(source, request = fetch) {
  const parts = source.pathname.split('/').filter(Boolean);
  const slug = source.hostname === 'clips.twitch.tv' ? parts[0] : parts[parts.indexOf('clip') + 1];
  if (!['clips.twitch.tv', 'twitch.tv', 'www.twitch.tv'].includes(source.hostname) ||
      (source.hostname !== 'clips.twitch.tv' && !parts.includes('clip')) || !/^[A-Za-z0-9_-]{1,180}$/.test(slug || '')) {
    return { available: false, reason: 'invalid_clip' };
  }
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return { available: false, reason: 'clip_playback_not_configured' };
  try {
    if (!cachedToken || cachedToken.id !== id || cachedToken.until < Date.now()) {
      const response = await request('https://id.twitch.tv/oauth2/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(7000) });
      const token = await response.json();
      if (!response.ok || !token.access_token) throw Error('token_failed');
      cachedToken = { id, token: token.access_token, until: Date.now() + Math.max(0, Number(token.expires_in || 0) - 60) * 1000 };
    }
    const headers = { 'Client-Id': id, Authorization: 'Bearer ' + cachedToken.token };
    const response = await request('https://api.twitch.tv/helix/clips?id=' + encodeURIComponent(slug), { headers, signal: AbortSignal.timeout(7000) });
    if (response.status === 401) cachedToken = null;
    if (!response.ok) throw Error('clip_lookup_failed');
    const clip = (await response.json()).data?.[0];
    const playback = normalizeClipPlayback(clip);
    if (!playback.available) return playback;
    const video = await request('https://api.twitch.tv/helix/videos?id=' + playback.videoId, { headers, signal: AbortSignal.timeout(7000) });
    if (!video.ok || !(await video.json()).data?.length) return { available: false, reason: 'source_video_unavailable' };
    return playback;
  } catch { return { available: false, reason: 'clip_lookup_unavailable' }; }
}
