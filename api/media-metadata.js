import { isValidMediaDuration } from '../src/durationLookup.js';

const ALLOWED_MEDIA_HOSTS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'www.tiktok.com', 'tiktok.com', 'm.tiktok.com',
  'clips.twitch.tv', 'www.twitch.tv', 'twitch.tv',
  'kick.com', 'www.kick.com', 'clip.kick.com', 'clips.kick.com'
];

let twitchAppAccessTokenCache = { token: '', expiresAt: 0 };

export function extractTwitchClipSlug(value) {
  try {
    const source = value instanceof URL ? value : new URL(String(value));
    const host = source.hostname.toLowerCase();
    if (host === 'clips.twitch.tv') return source.pathname.split('/').filter(Boolean)[0] || '';
    if (host !== 'twitch.tv' && host !== 'www.twitch.tv') return '';
    const segments = source.pathname.split('/').filter(Boolean);
    const clipIndex = segments.findIndex((segment) => segment.toLowerCase() === 'clip');
    return clipIndex >= 0 ? segments[clipIndex + 1] || '' : '';
  } catch { return ''; }
}

export function normalizeTwitchClipPlayback(clip) {
  const videoId = String(clip?.video_id || '').trim();
  const vodOffset = Number(clip?.vod_offset);
  const durationSec = Number(clip?.duration);
  if (!videoId || !Number.isFinite(vodOffset) || vodOffset < 0 || !isValidMediaDuration(durationSec)) return null;
  return {
    videoId,
    vodOffset: Math.floor(vodOffset),
    durationSec: Math.round(durationSec),
  };
}

async function getTwitchAppAccessToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return '';
  if (twitchAppAccessTokenCache.token && twitchAppAccessTokenCache.expiresAt > Date.now() + 30_000) {
    return twitchAppAccessTokenCache.token;
  }
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return '';
    const payload = await response.json().catch(() => ({}));
    const token = String(payload?.access_token || '');
    const expiresIn = Number(payload?.expires_in);
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) return '';
    twitchAppAccessTokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  } catch { return ''; }
}

async function fetchTwitchClipPlayback(source) {
  const slug = extractTwitchClipSlug(source);
  if (!slug) return null;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const accessToken = await getTwitchAppAccessToken();
  if (!clientId || !accessToken) return null;
  try {
    const endpoint = new URL('https://api.twitch.tv/helix/clips');
    endpoint.searchParams.set('id', slug);
    const response = await fetch(endpoint, {
      headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(2200),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return normalizeTwitchClipPlayback(payload?.data?.[0]);
  } catch { return null; }
}

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_MEDIA_HOSTS.includes(host) || host.endsWith('.tiktok.com') || host.endsWith('.youtube.com');
}
export function parseIso8601Duration(value) {
  const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match || !String(value || '').toUpperCase().startsWith('P')) return null;
  const seconds = Number(match[1] || 0) * 86400 +
    Number(match[2] || 0) * 3600 +
    Number(match[3] || 0) * 60 +
    Number(match[4] || 0);
  return isValidMediaDuration(seconds) ? Math.round(seconds) : null;
}
function formatDuration(seconds) {
  if (!isValidMediaDuration(seconds)) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(remainder) : minutes + ':' + pad(remainder);
}
function getYouTubeVideoId(source, host) {
  if (host === 'youtu.be') return source.pathname.split('/').filter(Boolean)[0] || '';
  if (!host.endsWith('youtube.com')) return '';
  return source.searchParams.get('v') || source.pathname.match(/\/(?:shorts|embed|live|v)\/([\w-]{11})/i)?.[1] || '';
}
function readAttribute(tag, name) {
  const pattern = new RegExp(String(name) + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", 'i');
  const match = String(tag || '').match(pattern);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}
export function parseDurationFromPlayerResponse(payload) {
  const seconds = Number(payload?.videoDetails?.lengthSeconds || payload?.microformat?.playerMicroformatRenderer?.lengthSeconds);
  return isValidMediaDuration(seconds) ? Math.round(seconds) : null;
}

function extractJsonObjectAfterMarker(source, marker) {
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) return null;
  const start = source.indexOf('{', markerAt + marker.length);
  if (start < 0 || start - markerAt > 1200) return null;
  const scanEnd = Math.min(source.length, start + 3_000_000);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < scanEnd; i += 1) {
    const character = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character.charCodeAt(0) === 92) escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function findTikTokVideoDuration(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 32) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findTikTokVideoDuration(item, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (value.video && typeof value.video === 'object') {
    const seconds = Number(value.video.duration);
    if (isValidMediaDuration(seconds)) return Math.round(seconds);
  }
  for (const child of Object.values(value)) {
    const result = findTikTokVideoDuration(child, depth + 1);
    if (result) return result;
  }
  return null;
}

function findInlineVideoObjectDuration(source) {
  const videoKeys = /["']video["']\s*:/gi;
  let match;
  while ((match = videoKeys.exec(source))) {
    const candidate = extractJsonObjectAfterMarker(source.slice(match.index), 'video');
    const seconds = Number(candidate?.duration);
    if (isValidMediaDuration(seconds)) return Math.round(seconds);
    // Keep searching if the first "video" key belongs to unrelated page metadata.
    if (videoKeys.lastIndex <= match.index) videoKeys.lastIndex = match.index + match[0].length;
  }
  return null;
}

export function parseDurationFromHtml(html) {
  const source = String(html || '').slice(0, 8_000_000);
  const metaTags = source.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const name = readAttribute(tag, 'property') || readAttribute(tag, 'name') || readAttribute(tag, 'itemprop');
    if (!/(?:video:duration|og:video:duration|^duration$)/i.test(name)) continue;
    const content = readAttribute(tag, 'content');
    const isoSeconds = parseIso8601Duration(content);
    if (isoSeconds) return isoSeconds;
    const value = Number(content);
    if (isValidMediaDuration(value)) return Math.round(value);
  }

  // Structured player payloads avoid false positives from unrelated page timers.
  const playerResponse = extractJsonObjectAfterMarker(source, 'ytInitialPlayerResponse');
  const playerDuration = parseDurationFromPlayerResponse(playerResponse);
  if (playerDuration) return playerDuration;
  for (const marker of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__']) {
    const structured = extractJsonObjectAfterMarker(source, marker);
    const duration = findTikTokVideoDuration(structured);
    if (duration) return duration;
  }
  const inlineVideoDuration = findInlineVideoObjectDuration(source);
  if (inlineVideoDuration) return inlineVideoDuration;

  const youtubeLength = source.match(/"lengthSeconds"\s*:\s*"?([0-9]+)"?/i);
  if (youtubeLength && isValidMediaDuration(Number(youtubeLength[1]))) return Number(youtubeLength[1]);
  const milliseconds = source.match(/"approxDurationMs"\s*:\s*"([0-9]+)"/i);
  if (milliseconds) {
    const seconds = Math.round(Number(milliseconds[1]) / 1000);
    if (isValidMediaDuration(seconds)) return seconds;
  }
  const isoDuration = source.match(/"(?:duration|contentDuration)"\s*:\s*"(P[^"]+)"/i);
  if (isoDuration) {
    const seconds = parseIso8601Duration(isoDuration[1]);
    if (seconds) return seconds;
  }
  const numericDuration = /["']?(?:durationSeconds|duration_seconds)["']?\s*:\s*["']?([0-9]{1,7})["']?/i.exec(source);
  if (numericDuration) {
    const seconds = Number(numericDuration[1]);
    if (isValidMediaDuration(seconds)) return seconds;
  }
  return null;
}

function getProviderFamily(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  if (host === 'kick.com' || host.endsWith('.kick.com')) return 'kick';
  return '';
}

async function fetchDurationFromPage(source) {
  try {
    const initialFamily = getProviderFamily(source.hostname);
    if (!initialFamily) return null;
    let current = new URL(source.href);
    const signal = AbortSignal.timeout(3500);
    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const response = await fetch(current.href, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        redirect: 'manual',
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirectCount === 4) return null;
        const next = new URL(location, current);
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password ||
            !isAllowedHost(next.hostname) || getProviderFamily(next.hostname) !== initialFamily) return null;
        current = next;
        continue;
      }
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return null;
      return parseDurationFromHtml(await response.text());
    }
    return null;
  } catch { return null; }
}

async function fetchYouTubeApiDuration(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !videoId) return null;
  try {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
    endpoint.search = new URLSearchParams({ part: 'contentDetails', id: videoId, key: apiKey }).toString();
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2200) });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return parseIso8601Duration(payload.items?.[0]?.contentDetails?.duration);
  } catch { return null; }
}
async function fetchYouTubeInnertubeDuration(videoId, clientKind = 'WEB') {
  if (!videoId) return null;
  const isAndroid = clientKind === 'ANDROID';
  const clientVersion = isAndroid ? '20.10.38' : '2.20261022.01.00';
  const client = isAndroid
    ? { clientName: 'ANDROID', clientVersion, androidSdkVersion: 35, hl: 'en', gl: 'US' }
    : { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' };
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.youtube.com',
        'User-Agent': isAndroid
          ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 15; en_US)'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'X-YouTube-Client-Name': isAndroid ? '3' : '1',
        'X-YouTube-Client-Version': clientVersion
      },
      body: JSON.stringify({ videoId, context: { client } }),
      signal: AbortSignal.timeout(2800)
    });
    if (!response.ok) return null;
    return parseDurationFromPlayerResponse(await response.json().catch(() => ({})));
  } catch { return null; }
}
function getTikTokVideoId(source) {
  return source.pathname.match(/\/(?:video|player\/v1)\/(\d{10,25})/i)?.[1] ||
    source.searchParams.get('item_id') ||
    source.searchParams.get('video_id') ||
    source.searchParams.get('itemId') || '';
}
async function fetchTikTokItem(source) {
  const videoId = getTikTokVideoId(source);
  if (!videoId) return null;
  try {
    const endpoint = new URL('https://www.tiktok.com/api/item/detail/');
    endpoint.search = new URLSearchParams({
      aid: '1988',
      app_name: 'tiktok_web',
      app_language: 'en',
      itemId: videoId
    }).toString();
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://www.tiktok.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(2800)
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const item = payload?.itemInfo?.itemStruct;
    return item && typeof item === 'object' ? item : null;
  } catch { return null; }
}

async function fetchTikTokApiDuration(source, itemPromise = null) {
  const item = await (itemPromise || fetchTikTokItem(source));
  const seconds = Number(item?.video?.duration);
  return isValidMediaDuration(seconds) ? Math.round(seconds) : null;
}

async function fetchMediaDuration(source, host, tiktokItemPromise = null) {
  const normalizedHost = String(host || '').toLowerCase();
  const isYouTube = normalizedHost === 'youtu.be' || normalizedHost.endsWith('youtube.com');
  const isTikTok = normalizedHost === 'tiktok.com' || normalizedHost.endsWith('.tiktok.com');

  if (isYouTube) {
    const videoId = getYouTubeVideoId(source, normalizedHost);
    if (!videoId) return {
      seconds: null, provider: 'youtube', reason: 'The URL did not contain a recognizable YouTube video ID.'
    };
    const fromApi = await fetchYouTubeApiDuration(videoId);
    if (fromApi) return { seconds: fromApi, provider: 'youtube-data-api', reason: '' };
    const [fromWebPlayer, fromAndroidPlayer, fromPage] = await Promise.all([
      fetchYouTubeInnertubeDuration(videoId, 'WEB'),
      fetchYouTubeInnertubeDuration(videoId, 'ANDROID'),
      fetchDurationFromPage(source),
    ]);
    if (fromWebPlayer) return { seconds: fromWebPlayer, provider: 'youtube-player-web', reason: '' };
    if (fromAndroidPlayer) return { seconds: fromAndroidPlayer, provider: 'youtube-player-android', reason: '' };
    if (fromPage) return { seconds: fromPage, provider: 'youtube-watch-page', reason: '' };
    return {
      seconds: null,
      provider: 'youtube',
      reason: 'YouTube did not expose duration metadata to the server. Private, removed, age/region-restricted, or temporarily throttled videos may require YOUTUBE_API_KEY or the embedded player to load.'
    };
  }

  if (isTikTok) {
    const videoId = getTikTokVideoId(source);
    if (!videoId) return {
      seconds: null, provider: 'tiktok', reason: 'The URL did not contain a resolved TikTok video ID.'
    };
    const [fromApi, fromPage] = await Promise.all([
      fetchTikTokApiDuration(source, tiktokItemPromise),
      fetchDurationFromPage(source),
    ]);
    if (fromApi) return { seconds: fromApi, provider: 'tiktok-item-api', reason: '' };
    if (fromPage) return { seconds: fromPage, provider: 'tiktok-watch-page', reason: '' };
    return {
      seconds: null,
      provider: 'tiktok',
      reason: 'TikTok did not expose duration in its server response. Its embedded player can still report the exact length once that video loads.'
    };
  }

  const fromPage = await fetchDurationFromPage(source);
  return fromPage
    ? { seconds: fromPage, provider: normalizedHost.includes('twitch.tv') ? 'twitch-page' : 'kick-page', reason: '' }
    : { seconds: null, provider: normalizedHost, reason: 'The provider page did not expose duration metadata.' };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const rawUrl = typeof req.query?.url === 'string' ? req.query.url : '';
  let source;
  try { source = new URL(rawUrl); } catch {
    return res.status(400).json({ error: 'Provide a valid public media URL.' });
  }
  const host = source.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || !isAllowedHost(host)) {
    return res.status(400).json({ error: 'Only public YouTube, TikTok, Twitch, and Kick links are supported.' });
  }
  let endpoint = '';
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    endpoint = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(source.href) + '&format=json';
  } else if (host.endsWith('tiktok.com')) {
    endpoint = 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(source.href);
  } else if (host === 'clips.twitch.tv' || (host.endsWith('twitch.tv') && source.pathname.includes('/clip/'))) {
    endpoint = 'https://clips.twitch.tv/oembed?url=' + encodeURIComponent(source.href) + '&format=json';
  }
  const tiktokItemPromise = host === 'tiktok.com' || host.endsWith('.tiktok.com')
    ? fetchTikTokItem(source)
    : Promise.resolve(null);
  const isTwitchClip = host === 'clips.twitch.tv' || ((host === 'twitch.tv' || host === 'www.twitch.tv') && source.pathname.toLowerCase().includes('/clip/'));
  const twitchClipPromise = isTwitchClip ? fetchTwitchClipPlayback(source) : Promise.resolve(null);
  const metadataPromise = endpoint
    ? fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'WhaleCumMetadata/1.0' },
      signal: AbortSignal.timeout(5000)
    }).then(async (response) => response.ok ? response.json().catch(() => ({})) : {}).catch(() => ({}))
    : Promise.resolve({});
  const durationPromise = fetchMediaDuration(source, host, tiktokItemPromise);
  const [oembed, durationResult, tiktokItem, twitchClipPlayback] = await Promise.all([metadataPromise, durationPromise, tiktokItemPromise, twitchClipPromise]);
  const data = oembed && typeof oembed === 'object' ? oembed : {};
  const tiktokVideo = tiktokItem?.video && typeof tiktokItem.video === 'object' ? tiktokItem.video : {};
  const tiktokAuthor = tiktokItem?.author && typeof tiktokItem.author === 'object' ? tiktokItem.author : {};
  const title = (typeof data.title === 'string' && data.title.trim()) ||
    (typeof tiktokItem?.desc === 'string' && tiktokItem.desc.trim()) ||
    (typeof tiktokAuthor.nickname === 'string' && tiktokAuthor.nickname.trim() ? tiktokAuthor.nickname.trim() + ' on TikTok' : '');
  const authorName = (typeof data.author_name === 'string' && data.author_name.trim()) ||
    String(tiktokAuthor.nickname || tiktokAuthor.uniqueId || '').trim();
  const thumbnailUrl = (typeof data.thumbnail_url === 'string' && data.thumbnail_url.trim()) ||
    String(tiktokVideo.cover || tiktokVideo.originCover || tiktokVideo.dynamicCover || '').trim();
  const durationSec = isValidMediaDuration(durationResult?.seconds) ? Math.round(durationResult.seconds) : null;
  return res.status(200).json({
    title: String(title).slice(0, 400),
    authorName: String(authorName).slice(0, 100),
    thumbnailUrl,
    durationSec,
    duration: durationSec ? formatDuration(durationSec) : '',
    durationSource: durationSec ? 'metadata' : 'unknown',
    durationProvider: String(durationResult?.provider || ''),
    durationReason: durationSec ? '' : String(durationResult?.reason || 'The provider did not return duration metadata.').slice(0, 360),
    metadataAvailable: Boolean(title || thumbnailUrl || durationSec),
    twitchClipPlayback: twitchClipPlayback || null
  });
}
