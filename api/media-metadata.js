const ALLOWED_MEDIA_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.tiktok.com',
  'tiktok.com',
  'm.tiktok.com',
  'clips.twitch.tv',
  'www.twitch.tv',
  'twitch.tv',
];

function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_MEDIA_HOSTS.includes(host) || host.endsWith('.tiktok.com') || host.endsWith('.youtube.com');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const rawUrl = typeof req.query?.url === 'string' ? req.query.url : '';
  let source;
  try {
    source = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Provide a valid public media URL.' });
  }

  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || !isAllowedHost(source.hostname)) {
    return res.status(400).json({ error: 'Only public YouTube, TikTok, and Twitch links are supported.' });
  }

  const host = source.hostname.toLowerCase();
  let endpoint;
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(source.href)}&format=json`;
  } else if (host.endsWith('tiktok.com')) {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(source.href)}`;
  } else if (host === 'clips.twitch.tv' || (host.endsWith('twitch.tv') && source.pathname.includes('/clip/'))) {
    endpoint = `https://clips.twitch.tv/oembed?url=${encodeURIComponent(source.href)}&format=json`;
  } else {
    return res.status(400).json({ error: 'Unsupported media site.' });
  }

  try {
    const upstream = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'StreamPulse-GachiArena/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) return res.status(200).json({ title: '', metadataAvailable: false });
    const data = await upstream.json();
    return res.status(200).json({
      title: typeof data.title === 'string' ? data.title.slice(0, 400) : '',
      authorName: typeof data.author_name === 'string' ? data.author_name.slice(0, 100) : '',
      thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : '',
      metadataAvailable: Boolean(data.title),
    });
  } catch {
    // Metadata is a best-effort helper; a link should still be queued if the provider is unavailable.
    return res.status(200).json({ title: '', metadataAvailable: false });
  }
}
