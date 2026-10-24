import { Gamepad2, Laugh, Music, Radio, Scissors, Sparkles } from 'lucide-react';

// Pure media-domain helpers live here so queue identity, platform parsing, and
// category classification can be tested without mounting the dashboard.
export const CATEGORY_META = {
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
      'esports', 'smash bros', 'roblox', 'highlight', 'ranked', 'ace', 'headshot'
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
      'skit', 'lol', 'kekw', 'cursed', 'brainrot'
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
      'asmr', 'cooking', 'travel', 'live stream'
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

/**
 * Multi-layered detection engine:
 * 1. Checks URL domains (music.youtube.com, clips.twitch.tv, tiktok.com, spotify, etc.)
 * 2. Checks hashtags in request command (e.g. #music, #gaming)
 * 3. Checks keyword heuristic weights across title & note
 * 4. Respects broadcaster mode (e.g. Music-Only streams)
 */
export function detectVideoCategory(url = '', title = '', note = '', streamMode = 'all') {
  const cleanUrl = (url || '').toLowerCase();
  const textBlob = `${cleanUrl} ${(title || '')} ${(note || '')}`.toLowerCase();

  // 1. Explicit hashtags
  if (textBlob.includes('#music') || textBlob.includes('#song')) return 'Music';
  if (textBlob.includes('#game') || textBlob.includes('#gaming')) return 'Gaming';
  if (textBlob.includes('#meme') || textBlob.includes('#funny')) return 'Memes';
  if (textBlob.includes('#clip')) return 'Clips';
  if (textBlob.includes('#irl') || textBlob.includes('#podcast')) return 'IRL';

  // 2. Strong URL Domain signals
  if (cleanUrl.includes('music.youtube.com') || cleanUrl.includes('spotify.com') || cleanUrl.includes('soundcloud.com')) {
    return 'Music';
  }
  if (cleanUrl.includes('clips.twitch.tv') || cleanUrl.includes('/clip/')) {
    return 'Clips';
  }
  // 3. Keyword Scoring Heuristics
  let bestCategory = streamMode === 'music_only' ? 'Music' : 'General';
  let highestScore = 0;

  for (const [catKey, catData] of Object.entries(CATEGORY_META)) {
    if (catKey === 'General') continue;
    let score = 0;
    for (const kw of catData.keywords) {
      if (textBlob.includes(kw)) {
        // High-confidence keywords grant higher weight
        if (kw === 'official music video' || kw === 'official audio' || kw === 'ost' || kw === 'lyric video') {
          score += 4;
        } else if (kw === 'valorant' || kw === 'cs2' || kw === 'speedrun' || kw === 'gameplay') {
          score += 3;
        } else if (kw === 'try not to laugh' || kw === 'shitpost') {
          score += 3;
        } else {
          score += 1;
        }
      }
    }
    if (score > highestScore) {
      highestScore = score;
      bestCategory = catKey;
    }
  }

  return bestCategory;
}

// Binary media classifier. Strong music signals win; everything else is labelled Non-Music.
// The request pipeline enriches URL-only submissions with public oEmbed titles when available.
export function detectMusicType(url = '', title = '', note = '', category = '') {
  const parsed = (() => { try { return new URL(String(url || '')); } catch { return null; } })();
  const host = (parsed?.hostname || '').toLowerCase().replace(/^www\./, '');
  const rawTitle = String(title || '').trim();
  const rawText = [rawTitle, String(note || '')].join(' ').toLowerCase();
  const normalizedText = rawText.replace(/[_]+/g, ' ').replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim();
  const paddedText = ' ' + normalizedText + ' ';
  const hasPhrase = (phrase) => paddedText.includes(' ' + phrase.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ');

  // Music-first platforms are strong evidence; a TikTok URL alone is not.
  if (host === 'music.youtube.com' || host === 'open.spotify.com' || host.endsWith('.spotify.com') ||
      host.endsWith('.soundcloud.com') || host === 'music.apple.com' || host === 'bandcamp.com' ||
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
    ['remix', 3], ['cover song', 3], ['piano cover', 3], ['guitar cover', 3],
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
    ['streamer', 2], ['speech', 3], ['debate', 3]
  ];
  const musicScore = musicSignals.reduce((score, [phrase, weight]) => score + (hasPhrase(phrase) ? weight : 0), 0);
  const nonMusicScore = nonMusicSignals.reduce((score, [phrase, weight]) => score + (hasPhrase(phrase) ? weight : 0), 0);

  // YouTube track uploads often use "Artist - Track" naming without saying "music" anywhere.
  // Only use this fallback for YouTube titles and otherwise-generic categories, after strong
  // non-music words have been ruled out (so things like "Artist - Interview" stay Non-Music).
  const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  const titleParts = rawTitle.split(/\s[-–—|]\s/);
  const looksLikeArtistTrackTitle = isYouTube &&
    (String(category || '').trim() === '' || String(category || '').trim() === 'General') &&
    titleParts.length === 2 &&
    titleParts[0].trim().length >= 2 &&
    titleParts[1].trim().length >= 2 &&
    rawTitle.length <= 110;

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
  if (video.categoryManuallySet === true) return category;

  // Keep auto-detected category and media-type filters mutually consistent.
  // Older requests can still carry a stale "Music" category even when the
  // stronger media-type detector identifies them as non-music.
  if (getVideoMediaType(video) === 'Music') return 'Music';
  return category === 'Music' ? 'General' : category;
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
  // An active request must never be hidden by or deleted in favor of an old
  // History row for the same URL. Replay from History is explicitly allowed.
  if (status === 'playing') return 4;
  if (status === 'queue') return 3;
  if (status === 'watch_later') return 2;
  if (status === 'watched') return 1;
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
    const identityKey = url || hasPlatformId
      ? getMediaIdentityKey(platform, videoId, url)
      : 'entry:' + String(video.id || index);
    const existing = winners.get(identityKey);
    if (!existing) {
      winners.set(identityKey, video);
      return;
    }

    // Prefer the active queue over History, which is no longer a cooldown
    // or duplicate blocker. Among equally active copies keep the oldest request.
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


// Watched videos are requestable immediately. Keep these exports for existing
// callers, but never gate History replay on an elapsed-time restriction.
export const MEDIA_HISTORY_COOLDOWN_MS = 0;

export function getMediaHistoryCooldownRemainingMs(_video = {}) {
  return 0;
}

export function isMediaHistoryCooldownExpired(video = {}) {
  return String(video?.status || '').toLowerCase() === 'watched';
}

function parseMediaTimeValue(value) {
  const raw = String(value || "").trim().replace(/^t=/i, "");
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Math.floor(Number(raw));
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : null;
  }
  const colon = raw.match(/^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colon) {
    const seconds = colon[3] === undefined
      ? Number(colon[1]) * 60 + Number(colon[2])
      : Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
    return Number.isFinite(seconds) && seconds <= 86400 ? seconds : null;
  }
  const units = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (units && (units[1] !== undefined || units[2] !== undefined || units[3] !== undefined)) {
    const seconds = Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0);
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? Math.floor(seconds) : null;
  }
  return null;
}

/**
 * Read a playback offset from standard YouTube parameters (t/start/time_continue),
 * URL fragments (#t=...), or a timestamp written after a chat URL (e.g. 1:23 / 90s).
 */
export function parseMediaStartSeconds(rawInput = "") {
  const input = String(rawInput || "").trim();
  if (!input) return 0;
  const urlMatch = input.match(/(?:https?:\/\/)?(?:(?:www|m)\.)?(?:music\.youtube\.com|youtube\.com|youtu\.be|vm\.tiktok\.com|vt\.tiktok\.com|tiktok\.com|clips\.twitch\.tv|twitch\.tv|clip\.kick\.com|kick\.com)\/[^\s<>]+/i);
  if (urlMatch) {
    const candidate = urlMatch[0].replace(/[.,!?;)\]]+$/g, "");
    try {
      const parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : "https://" + candidate);
      const value = parsed.searchParams.get("t") ||
        parsed.searchParams.get("start") ||
        parsed.searchParams.get("time_continue") ||
        parsed.hash.match(/(?:^#|[&#])t=([^&]+)/i)?.[1];
      if (value !== null && value !== undefined) {
        const seconds = parseMediaTimeValue(decodeURIComponent(String(value).replace(/\+/g, " ")));
        if (seconds !== null) return seconds;
      }
    } catch {
      // Fall through to a plain timestamp suffix if the pasted URL is malformed.
    }
    const afterUrl = input.slice((urlMatch.index || 0) + urlMatch[0].length)
      .trim()
      .replace(/^[,;|–—-]+\s*/, "")
      .replace(/^(?:at|start(?:ing)?\s+at|timestamp)\s*/i, "")
      .replace(/[.,!?;)\]]+$/g, "");
    return parseMediaTimeValue(afterUrl) ?? 0;
  }
  const plain = input.replace(/^!assr\s*/i, "").trim()
    .replace(/^(?:at|start(?:ing)?\s+at|timestamp)\s*/i, "");
  const exact = parseMediaTimeValue(plain);
  if (exact !== null) return exact;
  // For title-based requests, only treat an explicit clock or h/m/s token at the
  // end as a timestamp; ordinary trailing numbers in titles are left untouched.
  const suffix = plain.match(/\s+(?:(?:at|start(?:ing)?\s+at|timestamp)\s+)?((?:\d{1,3}:[0-5]?\d(?::[0-5]?\d)?)|(?:\d+(?:\.\d+)?(?:s|m|h))|(?:\d+h\d+m(?:\d+(?:\.\d+)?s?)?))\s*$/i);
  return suffix ? (parseMediaTimeValue(suffix[1]) ?? 0) : 0;
}

/** Remove an explicit end-of-request timestamp before searching the title on YouTube. */
export function stripMediaTimestampSuffix(rawInput = "") {
  const input = String(rawInput || "").trim();
  const urlMatch = input.match(/(?:https?:\/\/)?(?:(?:www|m)\.)?(?:music\.youtube\.com|youtube\.com|youtu\.be|vm\.tiktok\.com|vt\.tiktok\.com|tiktok\.com|clips\.twitch\.tv|twitch\.tv|clip\.kick\.com|kick\.com)\/[^\s<>]+/i);
  if (urlMatch) return { text: input, startSeconds: parseMediaStartSeconds(input) };
  const plain = input.replace(/^!assr\s*/i, "").trim();
  const suffix = plain.match(/\s+(?:(?:at|start(?:ing)?\s+at|timestamp)\s+)?((?:\d{1,3}:[0-5]?\d(?::[0-5]?\d)?)|(?:\d+(?:\.\d+)?(?:s|m|h))|(?:\d+h\d+m(?:\d+(?:\.\d+)?s?)?))\s*$/i);
  if (!suffix) return { text: plain, startSeconds: parseMediaStartSeconds(input) };
  const startSeconds = parseMediaTimeValue(suffix[1]);
  return startSeconds === null
    ? { text: plain, startSeconds: 0 }
    : { text: plain.slice(0, suffix.index).trim(), startSeconds };
}
