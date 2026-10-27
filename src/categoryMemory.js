export function titleKey(title = '') {
  return String(title).normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').slice(0, 400);
}

export function seriesKey(title = '') {
  // Only explicit episode/part numbering creates a family. No channel-wide guesses.
  const raw = String(title).replace(/(?:#\s*\d+|\b(?:ep(?:isode)?|part)\s*[.#:]?\s*\d+|\bs\d+e\d+)\b/gi, ' ');
  const key = titleKey(raw);
  return raw !== String(title) && key.length >= 14 && key.split(' ').length >= 3 ? key : '';
}

export function mediaKey(url = '') {
  try {
    const source = new URL(url), host = source.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be' || ['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      const id = host === 'youtu.be' ? source.pathname.slice(1).split('/')[0] : source.searchParams.get('v') || source.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
      if (id) return 'youtube:' + id;
    }
    return host + source.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

export function rememberCategory(rules, video, category, at = Date.now()) {
  const title = String(video.title || '').trim();
  const generic = /^(?:(?:youtube|tiktok|twitch|kick|external)\s+)?(?:media|video|short(?:\s+clip)?|clip|request|livestream|live stream)(?:\s*\([\w-]+\))?$/i.test(title);
  const example = { mediaKey: mediaKey(video.url), titleKey: !generic && titleKey(title).length >= 8 ? titleKey(title) : '', seriesKey: seriesKey(video.title), category, at };
  return [...(Array.isArray(rules) ? rules : []).filter(rule => rule && typeof rule === 'object').filter(rule => rule.mediaKey !== example.mediaKey && (!example.titleKey || rule.titleKey !== example.titleKey)), example].slice(-200);
}

export function learnedCategory(video, rules = []) {
  const media = mediaKey(video.url), title = titleKey(video.title), series = seriesKey(video.title);
  const entries = Array.isArray(rules) ? rules.filter(rule => rule && typeof rule === 'object').slice().reverse() : [];
  return entries.find(rule => media && rule.mediaKey === media)?.category ||
    entries.find(rule => title && rule.titleKey === title)?.category ||
    entries.find(rule => series && rule.seriesKey === series)?.category || '';
}

export function sanitizeClassificationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  return { version: 1, authorName: text(value.authorName, 100), channelId: text(value.channelId, 100),
    description: text(value.description, 1200), sourceCategory: text(value.sourceCategory, 60),
    tags: Array.isArray(value.tags) ? value.tags.filter(tag => typeof tag === 'string').slice(0, 20).map(tag => tag.slice(0, 60)) : [] };
}
