const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 180;
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3/search';

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getRendererText(value) {
  if (typeof value?.simpleText === 'string') return cleanText(value.simpleText);
  if (Array.isArray(value?.runs)) return cleanText(value.runs.map((run) => run?.text || '').join(''));
  return '';
}

function extractAssignedJson(html) {
  const marker = /(?:var\s+|window\[['"])?ytInitialData(?:['"]\])?\s*=\s*/g;
  let match;
  while ((match = marker.exec(html)) !== null) {
    const start = html.indexOf('{', marker.lastIndex);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const character = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
    marker.lastIndex = match.index + match[0].length;
  }
  return null;
}

function normalizeItems(items) {
  const seen = new Set();
  const results = [];
  for (const item of items || []) {
    const videoId = cleanText(item?.videoId || item?.id?.videoId);
    const title = cleanText(item?.titleText || item?.snippet?.title);
    if (!/^[\w-]{11}$/.test(videoId) || !title || seen.has(videoId)) continue;
    seen.add(videoId);
    results.push({
      videoId,
      title: title.slice(0, 180),
      channel: cleanText(item?.channel || item?.snippet?.channelTitle || item?.ownerText || item?.shortBylineText).slice(0, 90),
      url: 'https://www.youtube.com/watch?v=' + videoId,
      thumbnail: 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg'
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

function parseHtmlResults(data) {
  if (!data || typeof data !== 'object') return [];
  const stack = [data];
  const videos = [];
  const seen = new Set();
  while (stack.length && videos.length < MAX_RESULTS * 3) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    const renderer = current.videoRenderer;
    if (renderer && renderer.videoId && !seen.has(renderer.videoId)) {
      seen.add(renderer.videoId);
      videos.push({
        videoId: renderer.videoId,
        titleText: getRendererText(renderer.title),
        channel: getRendererText(renderer.ownerText || renderer.shortBylineText)
      });
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
    } else {
      for (const value of Object.values(current)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }
  return normalizeItems(videos);
}

async function searchWithDataApi(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  const url = new URL(YOUTUBE_API_BASE);
  url.search = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: String(MAX_RESULTS),
    q: query,
    key: apiKey
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(6500) });
  if (!response.ok) return [];
  const body = await response.json().catch(() => ({}));
  return normalizeItems(body.items);
}

async function searchWithYouTubePage(query) {
  const url = 'https://www.youtube.com/results?hl=en&search_query=' + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error('YouTube search returned HTTP ' + response.status + '.');
  const html = await response.text();
  if (!html || html.length > 8_000_000) throw new Error('YouTube returned an empty or unexpectedly large search response.');
  const data = extractAssignedJson(html);
  const results = parseHtmlResults(data);
  if (!results.length) throw new Error('No searchable YouTube results were returned.');
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = cleanText(req.query?.q).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_QUERY_LENGTH);
  if (query.length < 2) return res.status(400).json({ error: 'Enter at least two characters to search YouTube.' });

  try {
    let results = [];
    try {
      results = await searchWithDataApi(query);
    } catch (error) {
      console.warn('Configured YouTube Data API search failed; trying YouTube results page.', error?.message || error);
    }
    if (!results.length) results = await searchWithYouTubePage(query);
    return res.status(200).json({ query, results });
  } catch (error) {
    console.warn('YouTube title search failed:', error?.message || error);
    return res.status(502).json({
      error: 'YouTube title search is temporarily unavailable. Try again or request the direct video URL.'
    });
  }
}
