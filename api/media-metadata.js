import { isValidMediaDuration } from '../src/durationLookup.js';

const ALLOWED_MEDIA_HOSTS = [
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'www.tiktok.com', 'tiktok.com', 'm.tiktok.com',
  'clips.twitch.tv', 'www.twitch.tv', 'twitch.tv',
  'kick.com', 'www.kick.com', 'clip.kick.com', 'clips.kick.com'
];
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

export function parsePageMetadata(html, videoId = '') {
  const text = String(html || '').slice(0, 8_000_000);
  let hasTikTokItemData = false;
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const id = readAttribute(match[1], 'id');
    if (!['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE'].includes(id)) continue;
    try {
      const body = JSON.parse(match[2]);
      hasTikTokItemData = true;
      const main = body.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      const item = main && (!videoId || String(main.id) === videoId) ? main :
        videoId ? body.ItemModule?.[videoId] : Object.values(body.ItemModule || {})[0];
      if (item) return { title: typeof item.desc === 'string' ? item.desc.trim() : '', durationSec: isValidMediaDuration(item.video?.duration) ? Math.round(Number(item.video.duration)) : null,
        thumbnailUrl: typeof item.video?.cover === 'string' ? item.video.cover : '' };
    } catch { /* Public pages can contain unrelated or malformed script blocks. */ }
  }
  let title = '', thumbnailUrl = '';
  const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
    const key = readAttribute(tag, 'property') || readAttribute(tag, 'name');
    if (key === 'og:title') title = decode(readAttribute(tag, 'content'));
    if (key === 'og:image') thumbnailUrl = decode(readAttribute(tag, 'content'));
  }
  if (/^(?:TikTok(?: - Make Your Day)?|Make Your Day|YouTube)$/i.test(title)) title = '';
  return { title, thumbnailUrl, durationSec: videoId && hasTikTokItemData ? null : parseDurationFromHtml(text) };
}
const pageMetadataCache = new Map();
async function fetchPageMetadataUncached(source) {
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
      return parsePageMetadata(await response.text(), getTikTokVideoId(source));
    }
    return null;
  } catch { return null; }
}
function fetchPageMetadata(source) {
  const key = source.href, saved = pageMetadataCache.get(key);
  if (saved?.request === fetch && saved.until > Date.now()) return saved.promise;
  if (pageMetadataCache.size >= 100) pageMetadataCache.delete(pageMetadataCache.keys().next().value);
  const promise = fetchPageMetadataUncached(source);
  pageMetadataCache.set(key, { request: fetch, until: Date.now() + 60000, promise });
  return promise;
}
async function fetchDurationFromPage(source) { return (await fetchPageMetadata(source))?.durationSec || null; }

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
async function fetchTikTokApiDuration(source) {
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
    const seconds = Number(payload?.itemInfo?.itemStruct?.video?.duration);
    return isValidMediaDuration(seconds) ? Math.round(seconds) : null;
  } catch { return null; }
}

async function fetchMediaDuration(source, host) {
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
      fetchTikTokApiDuration(source),
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

  if (normalizedHost === 'clips.twitch.tv' || normalizedHost.endsWith('twitch.tv') && source.pathname.includes('/clip/')) {
    const { getClipPlayback } = await import('../server/twitch-clip-playback.js');
    const clip = await getClipPlayback(source, fetch, { metadataOnly: true });
    if (isValidMediaDuration(clip?.durationSeconds)) return { seconds: clip.durationSeconds, provider: 'twitch-clip-metadata', reason: '' };
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
  if (req.query?.playback === '1') {
    const { getClipPlayback } = await import('../server/twitch-clip-playback.js');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(await getClipPlayback(source, fetch, { refresh: req.query?.refresh === '1' }));
  }
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    endpoint = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(source.href) + '&format=json';
  } else if (host.endsWith('tiktok.com')) {
    endpoint = 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(source.href);
  } else if (host === 'clips.twitch.tv' || (host.endsWith('twitch.tv') && source.pathname.includes('/clip/'))) {
    endpoint = 'https://clips.twitch.tv/oembed?url=' + encodeURIComponent(source.href) + '&format=json';
  }
  const metadataPromise = endpoint
    ? fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'WhaleCumMetadata/1.0' },
      signal: AbortSignal.timeout(5000)
    }).then(async (response) => response.ok ? response.json().catch(() => ({})) : {}).catch(() => ({}))
    : Promise.resolve({});
  const durationPromise = fetchMediaDuration(source, host);
  const [data, durationResult, page] = await Promise.all([metadataPromise, durationPromise, fetchPageMetadata(source)]);
  const durationSec = isValidMediaDuration(durationResult?.seconds) ? Math.round(durationResult.seconds) : null;
  return res.status(200).json({
    title: (typeof data.title === 'string' && data.title.trim() ? data.title : page?.title || '').slice(0, 400),
    authorName: typeof data.author_name === 'string' ? data.author_name.slice(0, 100) : '',
    thumbnailUrl: typeof data.thumbnail_url === 'string' && data.thumbnail_url ? data.thumbnail_url : page?.thumbnailUrl || '',
    durationSec,
    duration: durationSec ? formatDuration(durationSec) : '',
    durationSource: durationSec ? 'metadata' : 'unknown',
    durationProvider: String(durationResult?.provider || ''),
    durationReason: durationSec ? '' : String(durationResult?.reason || 'The provider did not return duration metadata.').slice(0, 360),
    metadataAvailable: Boolean(data.title || page?.title || durationSec)
  });
}
