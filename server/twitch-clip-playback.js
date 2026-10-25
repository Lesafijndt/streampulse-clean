let cachedToken = null;
const publicClips = new Map();
// Anonymous public-web clip playback, as used by Twitch's share page. This is
// deliberately separate from app OAuth: it cannot grant access to private media.
const PUBLIC_CLIP_CLIENT = 'ue6666qo983tsx6so1t0vnawi233wa';
const SHARE_CLIP_HASH = '2db6a3b20eabf510bd3cf465ae2408834b59eb6b8af89ca73ab1486cacecfb63';
export function normalizePublicClip(clip) {
  if (!clip || clip.isPublished === false || !clip.playbackAccessToken?.signature || !clip.playbackAccessToken?.value) return null;
  const qualities = clip.assets?.[0]?.videoQualities || clip.videoQualities || [];
  const ordered = [...qualities].sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0));
  for (const source of ordered) {
    try {
      const url = new URL(source.sourceURL);
      if (url.protocol !== 'https:' || url.username || url.password ||
          !['.cloudfront.net', '.twitchcdn.net', '.twitch.tv'].some(suffix => url.hostname.endsWith(suffix))) continue;
      url.searchParams.set('sig', clip.playbackAccessToken.signature);
      url.searchParams.set('token', clip.playbackAccessToken.value);
      return { available: true, mode: 'direct', mediaUrl: url.href,
        durationSeconds: Number(clip.durationSeconds || clip.duration) || null };
    } catch { /* Try another public rendition. */ }
  }
  return null;
}
export async function getPublicClipPlayback(slug, request = fetch, refresh = false) {
  const cached = publicClips.get(slug);
  if (!refresh && request === fetch && cached?.until > Date.now()) return cached.value;
  try {
    const response = await request('https://gql.twitch.tv/gql', { method: 'POST',
      headers: { 'Client-ID': PUBLIC_CLIP_CLIENT, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ operationName: 'ShareClipRenderStatus', variables: { slug },
        extensions: { persistedQuery: { version: 1, sha256Hash: SHARE_CLIP_HASH } } }]),
      signal: AbortSignal.timeout(7000) });
    if (!response.ok) return null;
    const body = await response.json();
    const value = normalizePublicClip(body?.[0]?.data?.clip);
    if (value && request === fetch) {
      if (publicClips.size >= 100) publicClips.delete(publicClips.keys().next().value);
      publicClips.set(slug, { value, until: Date.now() + 60_000 });
    }
    return value;
  } catch { return null; }
}
export function normalizeClipPlayback(clip) {
  const offsetSeconds = Number(clip?.vod_offset), durationSeconds = Number(clip?.duration);
  if (!/^\d+$/.test(String(clip?.video_id || '')) || clip?.vod_offset == null ||
      !Number.isFinite(offsetSeconds) || offsetSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) {
    return { available: false, reason: 'source_video_unavailable' };
  }
  return { available: true, videoId: String(clip.video_id), offsetSeconds, durationSeconds };
}
export async function getClipPlayback(source, request = fetch, { refresh = false } = {}) {
  const parts = source.pathname.split('/').filter(Boolean);
  const slug = source.hostname === 'clips.twitch.tv' ? parts[0] : parts[parts.indexOf('clip') + 1];
  if (!['clips.twitch.tv', 'twitch.tv', 'www.twitch.tv'].includes(source.hostname) ||
      (source.hostname !== 'clips.twitch.tv' && !parts.includes('clip')) || !/^[A-Za-z0-9_-]{1,180}$/.test(slug || '')) {
    return { available: false, reason: 'invalid_clip' };
  }
  const direct = await getPublicClipPlayback(slug, request, refresh);
  if (direct) return direct;
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
