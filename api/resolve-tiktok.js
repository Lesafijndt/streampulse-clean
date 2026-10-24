const isTikTokHost = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
};

const extractVideoId = (value) => {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    const match = url.pathname.match(/\/(?:@[^/]+\/)?video\/(\d{10,25})/i)
      || url.pathname.match(/\/player\/v1\/(\d{10,25})/i)
      || url.search.match(/[?&](?:item_id|video_id)=(\d{10,25})/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
};

async function readPrefix(response, maxChars = 180000) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    while (result.length < maxChars) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    try { await reader.cancel(); } catch { /* body may already be closed */ }
  }
  return result.slice(0, maxChars);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let current;
  try {
    const raw = typeof req.query?.url === 'string' ? req.query.url : '';
    current = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Provide a valid TikTok URL.' });
  }

  if (current.protocol !== 'https:' || !isTikTokHost(current.hostname)) {
    return res.status(400).json({ error: 'Only HTTPS TikTok URLs can be resolved.' });
  }

  const initialId = extractVideoId(current);
  if (initialId) return res.status(200).json({ url: current.toString(), videoId: initialId });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    for (let hops = 0; hops < 6; hops += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Range': 'bytes=0-180000'
        }
      });

      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        const next = new URL(location, current);
        if (next.protocol !== 'https:' || !isTikTokHost(next.hostname)) {
          return res.status(422).json({ error: 'TikTok redirected to an unsupported destination.' });
        }
        current = next;
        const redirectedId = extractVideoId(current);
        if (redirectedId) return res.status(200).json({ url: current.toString(), videoId: redirectedId });
        continue;
      }

      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        return res.status(422).json({ error: `TikTok could not expand this link (HTTP ${response.status}). Try a full video URL.` });
      }

      const html = await readPrefix(response);
      const idFromHtml = html.match(/\/video\/(\d{10,25})/i)?.[1]
        || html.match(/(?:itemId|item_id|videoId|video_id)["'\s:=]+(\d{10,25})/i)?.[1];
      if (idFromHtml) {
        const canonical = `https://www.tiktok.com/player/v1/${idFromHtml}`;
        return res.status(200).json({ url: canonical, videoId: idFromHtml });
      }
      return res.status(422).json({ error: 'Could not find a public TikTok video ID in this link. Try copying the full TikTok video URL.' });
    }

    return res.status(422).json({ error: 'TikTok link redirected too many times. Copy the full video URL and try again.' });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'TikTok link resolution timed out. Copy the full TikTok video URL and try again.'
      : 'TikTok could not resolve this share link right now. Try the full video URL.';
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
