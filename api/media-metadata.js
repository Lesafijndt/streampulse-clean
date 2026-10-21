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
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
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
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? seconds : null;
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
    if (Number.isFinite(value) && value > 0 && value <= 86400) return value;
  }
  const youtubeLength = source.match(/"lengthSeconds"\s*:\s*"?([0-9]+)"?/i);
  if (youtubeLength && Number(youtubeLength[1]) > 0 && Number(youtubeLength[1]) <= 86400) return Number(youtubeLength[1]);
  const milliseconds = source.match(/"approxDurationMs"\s*:\s*"([0-9]+)"/i);
  if (milliseconds) {
    const seconds = Math.round(Number(milliseconds[1]) / 1000);
    if (seconds > 0 && seconds <= 86400) return seconds;
  }
  const tiktokVideo = source.match(/"video"\s*:\s*\{[^{}]{0,3000}?"duration"\s*:\s*([0-9]{1,5})/i);
  if (tiktokVideo) {
    const seconds = Number(tiktokVideo[1]);
    if (seconds > 0 && seconds <= 86400) return seconds;
  }
  const isoDuration = source.match(/"(?:duration|contentDuration)"\s*:\s*"(PT[^"]+)"/i);
  if (isoDuration) {
    const seconds = parseIso8601Duration(isoDuration[1]);
    if (seconds) return seconds;
  }
  const numericDuration = source.match(/["']?(?:durationSeconds|duration_seconds|duration)["']?\s*:\s*["']?([0-9]{1,6})["']?/i);
  if (numericDuration) {
    const seconds = Number(numericDuration[1]);
    if (seconds > 0 && seconds <= 86400) return seconds;
  }
  return null;
}
async function fetchDurationFromPage(source) {
  try {
    const response = await fetch(source.href, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; WhaleCumMetadata/1.0)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(2800)
    });
    if (!response.ok) return null;
    return parseDurationFromHtml(await response.text());
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
async function fetchYouTubeInnertubeDuration(videoId) {
  if (!videoId) return null;
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.youtube.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20261022.01.00'
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'WEB', clientVersion: '2.20261022.01.00', hl: 'en', gl: 'US' } }
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    return parseDurationFromPlayerResponse(await response.json().catch(() => ({})));
  } catch { return null; }
}
function getTikTokVideoId(source) {
  return source.pathname.match(/\/video\/(\d{10,25})/i)?.[1] ||
    source.searchParams.get('item_id') ||
    source.searchParams.get('video_id') || '';
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
    return Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? seconds : null;
  } catch { return null; }
}
async function fetchMediaDuration(source, host) {
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const fromApi = await fetchYouTubeApiDuration(getYouTubeVideoId(source, host));
    if (fromApi) return fromApi;
    // YouTube's public oEmbed response has no duration. Try its player metadata
    // endpoint alongside HTML parsing, which is increasingly blocked server-side.
    const [fromPlayer, fromPage] = await Promise.all([
      fetchYouTubeInnertubeDuration(getYouTubeVideoId(source, host)),
      fetchDurationFromPage(source)
    ]);
    return fromPlayer || fromPage || null;
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const fromApi = await fetchTikTokApiDuration(source);
    if (fromApi) return fromApi;
  }
  return fetchDurationFromPage(source);
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
  const metadataPromise = endpoint
    ? fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'WhaleCumMetadata/1.0' },
      signal: AbortSignal.timeout(5000)
    }).then(async (response) => response.ok ? response.json().catch(() => ({})) : {}).catch(() => ({}))
    : Promise.resolve({});
  const durationPromise = fetchMediaDuration(source, host);
  const [data, durationSec] = await Promise.all([metadataPromise, durationPromise]);
  return res.status(200).json({
    title: typeof data.title === 'string' ? data.title.slice(0, 400) : '',
    authorName: typeof data.author_name === 'string' ? data.author_name.slice(0, 100) : '',
    thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : '',
    durationSec: durationSec || null,
    duration: durationSec ? formatDuration(durationSec) : '',
    metadataAvailable: Boolean(data.title || durationSec)
  });
}
