import { Gamepad2, Laugh, Music, Radio, Scissors, Sparkles } from 'lucide-react';

// Pure media-domain helpers live here so queue identity, platform parsing, and
// category classification can be tested without mounting the dashboard.
export const CATEGORY_META = {
  Forsen: {
    label: 'Forsen',
    icon: Radio,
    badgeBg: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    colorHex: '#60a5fa',
    keywords: ['forsen', 'forsenlol', 'forsenspectate', 'forsen clips', 'hans eli sebastian fors', 'sebastian fors']
  },
  Music: {
    label: 'Music',
    icon: Music,
    badgeBg: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    colorHex: '#f43f5e',
    keywords: [
      'official music video', 'official video', 'official audio', 'lyrics',
      'lyric video', 'feat.', 'ft.', 'prod.', 'prod by', 'remix', 'soundtrack',
      'ost', 'bgm', 'instrumental', 'bass boosted', 'live performance', 'album',
      'lofi', 'synthwave', 'beat', 'trap', 'rap', 'hip hop', 'guitar', 'piano cover',
      'vocaloid', 'nightcore', 'orchestra', 'acoustic', 'visualizer', 'ep', 'single'
    ]
  },
  Gaming: {
    label: 'Blind Playthroughs',
    icon: Gamepad2,
    badgeBg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    colorHex: '#10b981',
    keywords: [
      'gameplay', 'walkthrough', 'speedrun', 'playthrough', 'fragmovie', 'montage',
      'clutch', 'valorant', 'cs2', 'counter-strike', 'fortnite', 'league of legends',
      'overwatch', 'apex legends', 'gta', 'minecraft', 'elden ring', 'boss fight',
      'esports', 'smash bros', 'roblox', 'ranked', 'headshot', 'team fortress 2',
      'dota 2', 'dota', 'fighting game', 'street fighter', 'tekken', 'mortal kombat', 'what is this game about',
      'let s play', 'blind playthrough', 'gaming', '\u043f\u0440\u043e\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u0435', '\u0433\u0435\u0439\u043c\u043f\u043b\u0435\u0439'
    ]
  },
  Memes: {
    label: 'Shitposts',
    icon: Laugh,
    badgeBg: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    colorHex: '#f59e0b',
    keywords: [
      'meme', 'funny', 'try not to laugh', 'ylyl', 'shitpost', 'hilarious',
      'joke', 'parody', 'fails', 'vines', 'trolling', 'comedy', 'prank',
      'skit', 'lol', 'kekw', 'cursed', 'brainrot', 'memes', 'shitposts',
      'shitposting', 'troll', 'trollface', 'rickroll', 'rickrolled', 'yes king',
      'laughing', 'funniest', 'memes compilation', 'trolled', 'prank call', 'prank calls',
      'biggest dick', 'boys being boys', 'gangster party line', 'sfm', 'gachimuchi',
      'gachi remix', 'right version', '\u043c\u0435\u043c', '\u043c\u0435\u043c\u044b', '\u043f\u0440\u0438\u043a\u043e\u043b', '\u043f\u0440\u0438\u043a\u043e\u043b\u044b'
    ]
  },
  Clips: {
    label: 'Twitch Clips',
    icon: Scissors,
    badgeBg: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    colorHex: '#8b5cf6',
    keywords: ['twitch clip', 'stream highlight', 'twitch.tv', 'clip', 'streamer react']
  },
  IRL: {
    label: 'IRL / Talk',
    icon: Radio,
    badgeBg: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    colorHex: '#06b6d4',
    keywords: [
      'podcast', 'interview', 'reaction', 'reacts', 'reacting', 'documentary',
      'debate', 'discussion', 'drama', 'vlog', 'commentary', 'unboxing', 'review',
      'asmr', 'cooking', 'travel', 'live stream', 'repair', 'restoration', 'can i fix',
      'how to fix', 'explained', 'news', 'tutorial', 'limmy s show', 'in walmart', '\u0438\u043d\u0442\u0435\u0440\u0432\u044c\u044e', '\u043f\u043e\u0434\u043a\u0430\u0441\u0442'
    ]
  },
  General: {
    label: 'General Video',
    icon: Sparkles,
    badgeBg: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    colorHex: '#94a3b8',
    keywords: []
  }
};

// Category is content-based; the Twitch Clips bucket is reserved for actual Twitch URLs.
export function isTwitchClipUrl(url = '') {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    return (host === 'clips.twitch.tv' && /^\/[^/]+/.test(parsed.pathname)) ||
      ((host === 'twitch.tv' || host === 'www.twitch.tv' || host === 'm.twitch.tv') && /^\/[^/]+\/clip\/[^/]+/.test(parsed.pathname));
  } catch { return false; }
}

// Normalize Unicode text consistently; hashtags can use compact multiword names.
function contentMatcher(title, note = '') {
  const text = (String(title || '') + ' ' + String(note || '')).replace(/https?:\/\/\S+/gi, '').replace(/@[\p{L}\p{N}_.]+/gu, '').normalize('NFKC').toLowerCase();
  const normalized = text.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const padded = ' ' + normalized + ' ';
  const tags = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(match => match[1].replace(/_/g, ''));
  return phrase => {
    const words = String(phrase).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return Boolean(words) && (padded.includes(' ' + words + ' ') || tags.includes(words.replace(/ /g, '')));
  };
}

export function detectVideoCategory(url = '', title = '', note = '', streamMode = 'all') {
  const has = contentMatcher(title, note);
  const forsenContent = contentMatcher(String(title).replace(/@(?=forsen\b)/gi, ''), String(note).replace(/@(?=forsen\b)/gi, ''));
  let forsenChannel = false;
  try {
    const source = new URL(String(url));
    forsenChannel = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'].includes(source.hostname.toLowerCase()) && /^\/forsen(?:\/|$)/i.test(source.pathname);
  } catch { /* A title can still identify Forsen without a parseable URL. */ }
  if (forsenChannel || CATEGORY_META.Forsen.keywords.some(forsenContent)) return 'Forsen';
  // Platform identity is reliable; content tags never turn non-Twitch URLs into clips.
  if (isTwitchClipUrl(url)) return 'Clips';
  if (has('limmy s show')) return 'IRL';
  if (CATEGORY_META.Memes.keywords.some(has)) return 'Memes';
  const music = detectMusicType(url, title, note) === 'Music';
  if (music) return 'Music';
  if (has('evo') && ['commentating', 'tournament', 'finals', 'fighting'].some(has)) return 'Gaming';
  let best = 'General', highest = 0;
  for (const key of ['Gaming', 'IRL']) {
    const score = CATEGORY_META[key].keywords.reduce((sum, word) => sum + (has(word) ? 1 : 0), 0);
    if (score > highest) { best = key; highest = score; }
  }
  // Talk/reaction/tutorial context wins over incidental music vocabulary.
  if (highest) return best;
  return 'General';
}

// Binary media classifier. Strong music signals win; everything else is labelled Non-Music.
// The request pipeline enriches URL-only submissions with public oEmbed titles when available.
export function detectMusicType(url = '', title = '', note = '', category = '') {
  const parsed = (() => { try { return new URL(String(url || '')); } catch { return null; } })();
  const host = (parsed?.hostname || '').toLowerCase().replace(/^www\./, '');
  const rawTitle = String(title || '').trim();
  const rawText = [rawTitle, String(note || '')].join(' ').toLowerCase();
  const hasPhrase = contentMatcher(rawTitle, note);

  // Music-first platforms are strong evidence; a TikTok URL alone is not.
  if (host === 'music.youtube.com' || host === 'open.spotify.com' || host.endsWith('.spotify.com') ||
      (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) || host === 'music.apple.com' || host === 'bandcamp.com' ||
      host.endsWith('.bandcamp.com')) return 'Music';
  if (String(category || '').trim().toLowerCase() === 'music') return 'Music';
  if (/(?:^|[\s#])(?:#music|#song|#songrequest|#nowplaying)(?:\b|$)/i.test(rawText)) return 'Music';

  const musicSignals = [
    ['official music video', 6], ['official audio', 6], ['official lyric video', 6],
    ['lyric video', 5], ['lyrics video', 5], ['music video', 5], ['visualizer', 5],
    ['full album', 5], ['full song', 5], ['original soundtrack', 5], ['soundtrack', 4],
    ['instrumental', 4], ['nightcore', 4], ['vocaloid', 4], ['karaoke', 4],
    ['bass boosted', 4], ['music mix', 4], ['dj set', 4], ['live session', 3],
    ['official mv', 4], ['audio only', 3], ['extended mix', 4], ['radio edit', 4],
    ['right version', 4], ['gachi remix', 5], ['remix', 3], ['cover song', 3], ['piano cover', 3], ['guitar cover', 3],
    ['acoustic version', 3], ['theme song', 4], ['opening theme', 4], ['ending theme', 4],
    ['lofi', 3], ['lo fi', 3], ['synthwave', 3], ['hip hop', 3], ['rap', 2],
    ['edm', 3], ['techno', 3], ['house music', 3], ['metal song', 3], ['jazz', 2],
    ['classical music', 3], ['orchestra', 2], ['bgm', 3], ['beat', 2],
    ['album', 2], ['single', 2], ['tracklist', 3], ['feat', 2], ['ft', 2],
    ['prod', 2], ['music', 2], ['song', 2], ['songs', 2]
  ];
  const nonMusicSignals = [
    ['gameplay', 4], ['walkthrough', 4], ['speedrun', 4], ['playthrough', 4],
    ['fragmovie', 4], ['tutorial', 3], ['how to', 3], ['review', 2],
    ['podcast', 5], ['interview', 4], ['documentary', 4], ['vlog', 3],
    ['reaction', 3], ['reacts', 3], ['try not to laugh', 5], ['meme', 4],
    ['shitpost', 5], ['comedy', 4], ['prank', 4], ['fails', 3],
    ['highlights', 2], ['twitch clip', 5], ['stream highlight', 5],
    ['news', 3], ['explained', 3], ['short clip', 3], ['funny clip', 4],
    ['repair', 5], ['can i fix', 5], ['episode', 4], ['commentating', 4], ['game about', 4],
    ['first date', 4], ['trolled', 4], ['skit', 5], ['sfm', 5], ['limmy s show', 5],
    ['streamer', 2], ['speech', 3], ['debate', 3]
  ];
  const musicScore = musicSignals.reduce((score, [phrase, weight]) => score + (hasPhrase(phrase) ? weight : 0), 0);
  const nonMusicScore = nonMusicSignals.reduce((score, [phrase, weight]) => score + (hasPhrase(phrase) ? weight : 0), 0);

  // YouTube track uploads often use "Artist - Track" naming without saying "music" anywhere.
  // Only use this fallback for YouTube titles and otherwise-generic categories, after strong
  // non-music words have been ruled out (so things like "Artist - Interview" stay Non-Music).
  const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  const titleParts = rawTitle.split(/\s[-\u2013\u2014|]\s/);
  // A dash is formatting, not evidence of a song. Only use this fallback for
  // unambiguous established performer names; unknown uploads need music signals.
  const knownArtists = ['pink floyd', 'linkin park', 'daft punk', 'michael jackson',
    'rick astley', 'the weeknd', 'arctic monkeys', 'red hot chili peppers',
    'dire straits', 'black sabbath', 'iron maiden', 'depeche mode', 'nine inch nails',
    'lana del rey', 'taylor swift', 'billie eilish', 'lady gaga', 'the beatles'];
  const looksLikeArtistTrackTitle = isYouTube && titleParts.length === 2 &&
    knownArtists.includes(titleParts[0].trim().toLowerCase()) && titleParts[1].trim().length >= 2;

  if (['podcast', 'interview', 'reaction', 'reacts', 'reacting', 'review', 'tutorial', 'documentary', 'can i fix', 'commentating', 'limmy s show'].some(hasPhrase)) return 'Non-Music';
  if (musicScore >= 3 && musicScore > nonMusicScore) return 'Music';
  if (looksLikeArtistTrackTitle && nonMusicScore === 0) return 'Music';
  return 'Non-Music';
}

// A staff-selected category is authoritative. Otherwise, strong music detection resolves
// both the category label and the Music/Non-Music badge so every part of the UI agrees.
export function getVideoMediaType(video = {}) {
  if (video.categoryManuallySet === true) {
    return String(video.category || '').trim() === 'Music' ? 'Music' : 'Non-Music';
  }
  return detectMusicType(video.url || '', video.title || '', video.note || '', '');
}

export function getVideoCategory(video = {}) {
  const category = CATEGORY_META[video.category] ? video.category : 'General';
  // Preserve staff choices except impossible legacy non-Twitch "Twitch Clips" labels.
  if (video.categoryManuallySet === true && (category !== 'Clips' || isTwitchClipUrl(video.url))) return category;
  return detectVideoCategory(video.url || '', video.title || '', video.note || '');
}

/**
 * Standardize media platform parsing
 */
export function getMediaIdentityKey(platform = '', videoId = '', rawUrl = '') {
  let normalizedPlatform = String(platform || 'web').trim().toLowerCase();
  let normalizedId = String(videoId || '').trim().toLowerCase();

  // Prefer the canonical ID from the URL so legacy records lacking platform/videoId
  // still match new requests (including youtu.be vs youtube.com and Shorts links).
  const cleanUrl = String(rawUrl || '').trim();
  const parsedFromUrl = cleanUrl ? parseMediaUrl(cleanUrl) : null;
  if (
    parsedFromUrl &&
    parsedFromUrl.platform &&
    parsedFromUrl.platform !== 'web' &&
    parsedFromUrl.videoId &&
    !String(parsedFromUrl.videoId).startsWith('ext-')
  ) {
    normalizedPlatform = String(parsedFromUrl.platform).trim().toLowerCase();
    normalizedId = String(parsedFromUrl.videoId).trim().toLowerCase();
  }

  if (normalizedPlatform !== 'web' && normalizedId && !normalizedId.startsWith('ext-')) {
    return normalizedPlatform + ':' + normalizedId;
  }

  // For generic media URLs, ignore common tracking parameters and trailing slashes.
  try {
    const parsed = new URL(cleanUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const ignoredParams = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'feature', 'si', 'share', 'ab_channel']);
    const query = [...parsed.searchParams.entries()]
      .filter(([key]) => !ignoredParams.has(key.toLowerCase()))
      .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
      .map(([key, value]) => key.toLowerCase() + '=' + value)
      .join('&');
    return 'url:' + host + pathname + (query ? '?' + query : '');
  } catch {
    return 'url:' + cleanUrl.replace(/\/+$/, '').toLowerCase();
  }
}

export function isVerticalMedia(video) {
  if (!video) return false;
  if (video.platform === 'tiktok' || video.isVertical === true) return true;
  return String(video.url || '').toLowerCase().includes('youtube.com/shorts/');
}

export function getStableMediaDocumentId(identityKey = '') {
  // Stable across browser sessions, so simultaneous Twitch-chat handlers write one Firestore row.
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  let hashC = 0x85ebca6b;
  const input = String(identityKey || '');
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x5bd1e995);
    hashC = Math.imul(hashC ^ code, 0x27d4eb2d);
  }
  return 'media-' + (hashA >>> 0).toString(36) + '-' +
    (hashB >>> 0).toString(36) + '-' + (hashC >>> 0).toString(36);
}

function getMediaStatusPriority(video) {
  const status = String(video?.status || '').toLowerCase();
  if (status === 'playing') return 4;
  if (status === 'watched') return 3;
  if (status === 'queue') return 2;
  if (status === 'watch_later') return 1;
  return 0;
}

export function dedupeMediaVideos(items) {
  const winners = new Map();
  const duplicateIds = [];

  (Array.isArray(items) ? items : []).forEach((video, index) => {
    if (!video || typeof video !== 'object') return;
    const url = String(video.url || '').trim();
    const platform = String(video.platform || 'web').trim().toLowerCase();
    const videoId = String(video.videoId || '').trim().toLowerCase();
    const hasPlatformId = platform !== 'web' && videoId && !videoId.startsWith('ext-');
    const mediaKey = url || hasPlatformId
      ? getMediaIdentityKey(platform, videoId, url)
      : 'entry:' + String(video.id || index);
    const identityKey = video.status === 'watched'
      ? 'history:' + String(video.id || index) : 'active:' + mediaKey;
    const existing = winners.get(identityKey);
    if (!existing) {
      winners.set(identityKey, video);
      return;
    }

    // Prefer the item that's already playing or further along in history. On ties,
    // keep the oldest request so an accidental second request cannot replay it.
    const existingPriority = getMediaStatusPriority(existing);
    const incomingPriority = getMediaStatusPriority(video);
    const existingTime = Number(existing.timestamp) || Number(existing.createdAt) || Number.MAX_SAFE_INTEGER;
    const incomingTime = Number(video.timestamp) || Number(video.createdAt) || Number.MAX_SAFE_INTEGER;
    const keepIncoming =
      incomingPriority > existingPriority ||
      (incomingPriority === existingPriority && incomingTime < existingTime) ||
      (incomingPriority === existingPriority && incomingTime === existingTime &&
        String(video.id || '').localeCompare(String(existing.id || '')) < 0);

    if (keepIncoming) {
      if (existing.id && String(existing.id) !== String(video.id)) duplicateIds.push(String(existing.id));
      winners.set(identityKey, video);
    } else if (video.id && String(video.id) !== String(existing.id)) {
      duplicateIds.push(String(video.id));
    }
  });

  return {
    videos: Array.from(winners.values()),
    duplicateIds: Array.from(new Set(duplicateIds)),
  };
}

export function parseMediaUrl(rawUrl = '') {
  const url = (rawUrl || '').trim();
  if (!url) return { platform: 'web', videoId: null, thumbnail: null };

  // YouTube / YouTube Music
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i);
  if (ytMatch && ytMatch[1]) {
    return {
      platform: 'youtube',
      videoId: ytMatch[1],
      thumbnail: `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`,
      isYouTubeMusic: url.includes('music.youtube.com')
    };
  }

  let parsedUrl = null;
  try { parsedUrl = new URL(url); } catch { /* Invalid URLs are treated as external links below. */ }
  const hostname = parsedUrl?.hostname?.toLowerCase() || '';

  // Twitch Clips
  if ((hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) && (url.includes('/clip/') || hostname === 'clips.twitch.tv')) {
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    const clipIndex = parts.indexOf('clip');
    const clipSlug = (clipIndex >= 0 ? parts[clipIndex + 1] : parts[0]) || 'TwitchClip';
    return {
      platform: 'twitch',
      videoId: clipSlug,
      thumbnail: `https://placehold.co/640x360/581c87/f3e8ff?text=Twitch+Clip+%E2%80%A2+${encodeURIComponent(clipSlug.slice(0, 10))}`
    };
  }

  // Kick Clips are queued as external media and open through the official Kick clip page.
  if (hostname === 'kick.com' || hostname.endsWith('.kick.com')) {
    const parts = (parsedUrl?.pathname || '').split('/').filter(Boolean);
    const clipIndex = parts.findIndex((part) => part.toLowerCase() === 'clips' || part.toLowerCase() === 'clip');
    const clipSlug = clipIndex >= 0 ? parts[clipIndex + 1] : (hostname === 'clip.kick.com' ? parts[0] : null);
    if (clipSlug) {
      return { platform: 'kick', videoId: clipSlug, thumbnail: 'https://placehold.co/640x360/18181b/53fc18?text=Kick+Clip' };
    }
  }

  // TikTok's official embedded player needs the numeric post ID. Short share URLs
  // are resolved by /api/resolve-tiktok on Vercel before the request is saved.
  const isTikTokHost = hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  if (isTikTokHost) {
    const idMatch = url.match(/(?:\/video\/|\/player\/v1\/)(\d{10,25})/i)
      || url.match(/[?&](?:item_id|video_id)=(\d{10,25})/i);
    const vid = idMatch?.[1] || null;
    return {
      platform: 'tiktok',
      videoId: vid,
      thumbnail: 'https://placehold.co/640x360/09090b/ff315f?text=TikTok+Video'
    };
  }

  return {
    platform: 'web',
    videoId: 'ext-' + Math.random().toString(36).substring(2, 8),
    thumbnail: 'https://placehold.co/640x360/18181b/a1a1aa?text=Web+Media+Link'
  };
}
