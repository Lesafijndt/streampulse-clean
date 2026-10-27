import { isActivePromotion } from './promotion.js';
import { MAX_MEDIA_DURATION_SECONDS } from './durationLookup.js';

export function formatMediaDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? hours + ':' + pad(minutes) + ':' + pad(remainder)
    : minutes + ':' + pad(remainder);
}

function isDefaultPlaceholderDuration(video) {
  if (!video || ['metadata', 'player'].includes(String(video.durationSource || ''))) return false;
  const platform = String(video.platform || '');
  return (
    Number(video.durationSec) === 45 &&
    String(video.duration || '') === '00:45' &&
    ['tiktok', 'twitch', 'kick'].includes(platform)
  ) || (
    Number(video.durationSec) === 225 &&
    String(video.duration || '') === '03:45'
  );
}

export function getDurationLabel(video) {
  if (!video || isDefaultPlaceholderDuration(video)) return '—';
  const seconds = Number(video.durationSec);
  if (Number.isFinite(seconds) && seconds > 0) return formatMediaDuration(seconds);
  const duration = String(video.duration || '').trim();
  if (/^(?:\d+:)?\d{1,2}:\d{2}$/.test(duration) && duration !== '00:45' && duration !== '03:45') {
    return duration;
  }
  if (duration && !['00:45', '03:45'].includes(duration)) return duration;
  return '—';
}

export function getQueueMediaCounts(videos, getVideoMediaType) {
  const queued = (videos || []).filter((video) => video.status === 'queue');
  return {
    queue: queued.length,
    music: queued.filter((video) => getVideoMediaType(video) === 'Music').length,
    nonMusic: queued.filter((video) => getVideoMediaType(video) === 'Non-Music').length
  };
}

export function buildCategoryCounts(videos, activeTab, mediaTypeFilter, getVideoCategory, getVideoMediaType) {
  const tabVideos = (videos || []).filter((video) => video.status === activeTab);
  const eligibleVideos = tabVideos.filter((video) =>
    mediaTypeFilter === 'All' || getVideoMediaType(video) === mediaTypeFilter
  );
  const counts = { All: eligibleVideos.length };
  tabVideos.forEach((video) => {
    const category = getVideoCategory(video);
    counts[category] = (counts[category] || 0) + 1;
  });
  return counts;
}

export function filterVideosForView(videos, options, helpers) {
  const { activeTab, selectedCategory, mediaTypeFilter, searchQuery, sortBy } = options;
  const { getVideoCategory, getVideoMediaType, compareQueueOrder } = helpers;
  const query = String(searchQuery || '').trim().toLowerCase();
  return (videos || [])
    .filter((video) => video.status === activeTab)
    .filter((video) => selectedCategory === 'All' || getVideoCategory(video) === selectedCategory)
    .filter((video) => mediaTypeFilter === 'All' || getVideoMediaType(video) === mediaTypeFilter)
    .filter((video) => {
      if (!query) return true;
      return String(video.title || '').toLowerCase().includes(query) ||
        String(video.requestedBy || '').toLowerCase().includes(query) ||
        String(video.category || '').toLowerCase().includes(query) ||
        String(video.note || '').toLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (activeTab === 'queue') return compareQueueOrder(a, b);
      if (activeTab === 'watched' && (sortBy === 'priority' || sortBy === 'played')) {
        return (Number(b.playedAt) || Number(b.timestamp) || 0) -
          (Number(a.playedAt) || Number(a.timestamp) || 0) ||
          (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) ||
          String(b.id || '').localeCompare(String(a.id || ''));
      }
      if (sortBy === 'played') return (Number(b.playedAt) || Number(b.timestamp) || 0) - (Number(a.playedAt) || Number(a.timestamp) || 0) || compareQueueOrder(a, b);
      if (sortBy === 'upvotes') return (Number(b.upvotes) || 0) - (Number(a.upvotes) || 0) || compareQueueOrder(a, b);
      if (sortBy === 'newest') return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0) || compareQueueOrder(a, b);
      return compareQueueOrder(a, b);
    });
}

export function selectNextVideoCandidate(videos, outgoing, compareQueueOrder) {
  const queuedItems = (videos || []).filter((video) =>
    video.status === 'queue' && String(video.id) !== String(outgoing?.id)
  );
  const returnTargetId = String(outgoing?.nextTrackOverrideId || '');
  const promotedNext = queuedItems.slice().sort(compareQueueOrder)[0];
  if (isActivePromotion(promotedNext)) return promotedNext;
  return (returnTargetId && queuedItems.find((video) => String(video.id) === returnTargetId)) ||
    queuedItems.slice().sort(compareQueueOrder)[0] ||
    null;
}

export function selectPreviousVideoCandidate(videos, outgoing) {
  return (videos || [])
    .filter((video) => video.status === 'watched' && String(video.id) !== String(outgoing?.id))
    .slice()
    .sort((a, b) =>
      (Number(b.playedAt) || Number(b.timestamp) || 0) -
      (Number(a.playedAt) || Number(a.timestamp) || 0) ||
      String(b.id || '').localeCompare(String(a.id || ''))
    )[0] || null;
}

export function buildNextTrackTransition(latestVideos, outgoing, compareQueueOrder, transitionAt = Date.now()) {
  const nextOne = selectNextVideoCandidate(latestVideos, outgoing, compareQueueOrder);
  const updatesById = new Map();
  (latestVideos || []).forEach((video) => {
    if (video.status === 'playing') {
      updatesById.set(String(video.id), {
        status: 'watched',
        watchedAt: new Date(transitionAt).toISOString(),
        playedAt: transitionAt,
        nextTrackOverrideId: null
      });
    }
  });
  updatesById.set(String(outgoing.id), {
    status: 'watched',
    watchedAt: new Date(transitionAt).toISOString(),
    playedAt: transitionAt,
    nextTrackOverrideId: null
  });
  if (nextOne) {
    updatesById.set(String(nextOne.id), {
      status: 'playing',
      pinned: false,
      playedAt: transitionAt + 1,
      nextTrackOverrideId: null
    });
  }
  const nextVideos = (latestVideos || []).map((video) => {
    const updates = updatesById.get(String(video.id));
    return updates ? { ...video, ...updates } : video;
  });
  return { updatesById, nextVideos, nextOne };
}

export function buildPreviousTrackTransition(latestVideos, outgoing, now = Date.now()) {
  const previouslyPlayed = selectPreviousVideoCandidate(latestVideos, outgoing);
  if (!previouslyPlayed) return { previouslyPlayed: null, updates: new Map(), nextVideos: latestVideos };
  const updates = new Map();
  if (outgoing) updates.set(String(outgoing.id), { status: 'queue', pinned: false, nextTrackOverrideId: null });
  updates.set(String(previouslyPlayed.id), {
      status: 'playing',
      pinned: false,
      playedAt: now,
      nextTrackOverrideId: outgoing ? String(outgoing.id) : null
    });
  const nextVideos = (latestVideos || []).map((video) => {
    const change = updates.get(String(video.id));
    return change ? { ...video, ...change } : video;
  });
  return { previouslyPlayed, updates, nextVideos };
}

export function buildQueueSyncWrites(updatesById, latestVideos, channelRoom) {
  return Array.from((updatesById || new Map()).entries()).map(([id, updates]) => {
    const item = (latestVideos || []).find((video) => String(video.id) === String(id)) || { id };
    return {
      id: String(id),
      payload: { ...item, ...updates, channelRoom }
    };
  });
}


// Wait-time estimates must distinguish provider-reported durations from fallbacks.
// The older client wrote 45s / 3:45 placeholders as if they were exact; never treat
// those known legacy values as genuine durations unless marked as provider metadata.
export function getDurationEstimate(video) {
  const platform = String(video?.platform || 'external').toLowerCase();
  const durationLabel = String(video?.duration || '').trim();
  const storedSeconds = Number(video?.durationSec);
  const hasProviderDuration = ['metadata', 'player'].includes(String(video?.durationSource || '')) &&
    Number.isFinite(storedSeconds) && storedSeconds > 0 && storedSeconds <= MAX_MEDIA_DURATION_SECONDS;

  if (hasProviderDuration) {
    const source = String(video?.durationSource || '') === 'player' ? 'player' : 'metadata';
    return { seconds: Math.round(storedSeconds), estimated: false, source };
  }

  const legacyPlaceholder = !['metadata', 'player'].includes(String(video?.durationSource || '')) && ((
    storedSeconds === 45 &&
    durationLabel === '00:45' &&
    ['tiktok', 'twitch', 'kick'].includes(platform)
  ) || (
    storedSeconds === 225 &&
    ['03:45', '3:45'].includes(durationLabel)
  ));

  if (!legacyPlaceholder && Number.isFinite(storedSeconds) && storedSeconds > 0 && storedSeconds <= MAX_MEDIA_DURATION_SECONDS) {
    return { seconds: Math.round(storedSeconds), estimated: false, source: 'saved' };
  }

  const match = durationLabel.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!legacyPlaceholder && match && !['00:45', '03:45'].includes(durationLabel)) {
    const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_MEDIA_DURATION_SECONDS) {
      return { seconds, estimated: false, source: 'saved' };
    }
  }

  // Conservative, clearly-estimated defaults for items where the provider hides duration.
  const isShort = Boolean(video?.isVertical) || /youtube\.com\/shorts\//i.test(String(video?.url || ''));
  const seconds = isShort ? 60
    : ['tiktok', 'twitch', 'kick'].includes(platform) ? 45
    : 180;
  return { seconds, estimated: true, source: 'fallback' };
}

export function estimateVideoDurationSeconds(video) {
  return getDurationEstimate(video).seconds;
}

export function createQueueBackup({
  channelRoom,
  videos = [],
  streamSettings = {},
  votedIds = {},
  savedAt = Date.now()
} = {}) {
  const backup = {
    format: 'whale-cum-backup',
    version: 1,
    channelRoom: String(channelRoom || '').trim().toLowerCase().replace(/^#/, ''),
    savedAt: Number.isFinite(Number(savedAt)) ? Number(savedAt) : Date.now(),
    videos: Array.isArray(videos) ? videos : [],
    streamSettings: streamSettings && typeof streamSettings === 'object' && !Array.isArray(streamSettings) ? streamSettings : {},
    votedIds: votedIds && typeof votedIds === 'object' && !Array.isArray(votedIds) ? votedIds : {}
  };
  // Strip undefined values and guarantee the exported object is JSON-downloadable.
  return JSON.parse(JSON.stringify(backup));
}

export function validateQueueBackup(value) {
  const invalid = (error) => ({ valid: false, error });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Backup file must contain a JSON object.');
  if (value.format !== 'whale-cum-backup' || value.version !== 1) {
    return invalid('Unsupported backup format or version.');
  }
  if (typeof value.channelRoom !== 'string' || !value.channelRoom.trim()) {
    return invalid('Backup is missing its channel name.');
  }
  if (!Array.isArray(value.videos) || value.videos.length > 5000) {
    return invalid('Backup queue/history must be an array of at most 5,000 items.');
  }
  if (!value.streamSettings || typeof value.streamSettings !== 'object' || Array.isArray(value.streamSettings)) {
    return invalid('Backup is missing valid stream settings.');
  }
  const validStatuses = new Set(['queue', 'playing', 'watched', 'watch_later']);
  const seenIds = new Set();
  for (const video of value.videos) {
    if (!video || typeof video !== 'object' || Array.isArray(video)) {
      return invalid('Backup contains an invalid video entry.');
    }
    const id = String(video.id || '').trim();
    if (!id || id.length > 240 || seenIds.has(id)) {
      return invalid('Backup contains a missing or duplicate video ID.');
    }
    seenIds.add(id);
    if (typeof video.url !== 'string' || typeof video.title !== 'string' || !validStatuses.has(video.status)) {
      return invalid('Backup contains an incomplete or unsupported video entry.');
    }
    if (video.url.trim()) {
      try {
        const url = new URL(video.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          return invalid('Backup contains an unsafe video URL.');
        }
      } catch {
        return invalid('Backup contains an invalid video URL.');
      }
    }
  }
  if (value.votedIds !== undefined && (!value.votedIds || typeof value.votedIds !== 'object' || Array.isArray(value.votedIds))) {
    return invalid('Backup vote data is invalid.');
  }

  return {
    valid: true,
    backup: {
      format: 'whale-cum-backup',
      version: 1,
      channelRoom: String(value.channelRoom).trim().toLowerCase().replace(/^#/, ''),
      savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0,
      videos: value.videos,
      streamSettings: value.streamSettings,
      votedIds: value.votedIds && typeof value.votedIds === 'object' && !Array.isArray(value.votedIds) ? value.votedIds : {}
    }
  };
}


export function buildQueueStatistics(videos = []) {
  const items = Array.isArray(videos) ? videos : [];
  const countsFor = (selector, sourceItems = items) => {
    const totals = new Map();
    sourceItems.forEach((video) => {
      const value = selector(video);
      if (!value) return;
      totals.set(value, (totals.get(value) || 0) + 1);
    });
    return [...totals.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const requesterOf = (video) => {
    const login = String(video?.requestedBy || '').trim().replace(/^@/, '').toLowerCase();
    return login && login !== 'viewer' && login !== 'unknown' ? login : '';
  };
  const requesters = new Set(items.map(requesterOf).filter(Boolean));
  const requesterCounts = countsFor(requesterOf);
  const platforms = countsFor((video) => {
    const platform = String(video?.platform || 'external').toLowerCase();
    return platform === 'web' ? 'external' : platform;
  });
  const genres = countsFor((video) => String(video?.category || video?.mediaType || 'General').trim() || 'General');
  const queued = items.filter((video) => video?.status === 'queue');
  const historyItems = items.filter((video) => video?.status === 'watched');
  const queueDurationEstimates = queued.map((video) => ({ video, ...getDurationEstimate(video) }));
  const queueEstimatedItems = queueDurationEstimates.filter((entry) => entry.estimated);
  const queueKnownItems = queueDurationEstimates.filter((entry) => !entry.estimated);
  return {
    totalRequests: items.length,
    totalRequesters: requesters.size,
    queueCount: queued.length,
    historyCount: historyItems.length,
    queueDurationSeconds: queueDurationEstimates.reduce((total, entry) => total + entry.seconds, 0),
    queueKnownDurationSeconds: queueKnownItems.reduce((total, entry) => total + entry.seconds, 0),
    queueEstimatedDurationSeconds: queueEstimatedItems.reduce((total, entry) => total + entry.seconds, 0),
    queueKnownCount: queueKnownItems.length,
    queueEstimatedCount: queueEstimatedItems.length,
    mostPopularPlatform: platforms[0] || null,
    mostPopularGenre: genres[0] || null,
    mostActiveRequester: requesterCounts[0] || null,
    platforms: platforms.slice(0, 4),
    genres: genres.slice(0, 4)
  };
}

export function formatRuntimeHoursMinutes(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '0h 0m';
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + 'h ' + minutes + 'm';
}

function readReliableDuration(video) {
  if (!video || typeof video !== 'object') return null;
  const source = String(video.durationSource || 'unknown').toLowerCase();
  const trustedSource = source === 'metadata' || source === 'player';
  const label = String(video.duration || '').trim();
  let seconds = Number(video.durationSec);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_MEDIA_DURATION_SECONDS) {
    const match = label.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    seconds = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  const platform = String(video.platform || '').toLowerCase();
  const legacyPlaceholder = !trustedSource && (
    (seconds === 45 && label === '00:45' && ['tiktok', 'twitch', 'kick'].includes(platform)) ||
    (seconds === 225 && ['03:45', '3:45'].includes(label))
  );
  if (legacyPlaceholder || seconds <= 0 || seconds > MAX_MEDIA_DURATION_SECONDS) return null;
  return {
    seconds: Math.round(seconds),
    duration: formatMediaDuration(seconds),
    durationSource: trustedSource ? source : 'saved',
    priority: source === 'player' ? 3 : source === 'metadata' ? 2 : 1
  };
}

// Prefer a locally known real duration over a stale/cache Firestore snapshot that has no duration.
// Merge only the immutable duration fields; cloud status, votes, ordering and other changes win.
export function mergeVideoDurationData(incomingVideos = [], currentVideos = []) {
  const currentById = new Map((Array.isArray(currentVideos) ? currentVideos : [])
    .map((video) => [String(video?.id ?? ''), video]));
  return (Array.isArray(incomingVideos) ? incomingVideos : []).map((incoming) => {
    const local = currentById.get(String(incoming?.id ?? ''));
    if (!local) return incoming;
    const incomingDuration = readReliableDuration(incoming);
    const localDuration = readReliableDuration(local);
    if (!localDuration || (incomingDuration && incomingDuration.priority >= localDuration.priority)) return incoming;
    return {
      ...incoming,
      duration: localDuration.duration,
      durationSec: localDuration.seconds,
      durationSource: localDuration.durationSource
    };
  });
}

export function getThumbnailDurationLabel(video) {
  const estimate = getDurationEstimate(video);
  const label = formatMediaDuration(estimate.seconds);
  return estimate.estimated ? '~' + (label || '3:00') : (label || '~3:00');
}

export function getDurationCacheKey(video) {
  const platform = String(video?.platform || 'external').toLowerCase();
  const videoId = String(video?.videoId || '').trim();
  if (videoId) return platform + ':' + videoId;
  const rawUrl = String(video?.url || '').trim();
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const removeKeys = new Set(['si', 'feature', 'pp', 't', 'start', 'utm_source', 'utm_medium', 'utm_campaign']);
    [...parsed.searchParams.keys()].forEach((key) => {
      if (removeKeys.has(key.toLowerCase())) parsed.searchParams.delete(key);
    });
    parsed.hash = '';
    return platform + ':' + parsed.hostname.toLowerCase() + parsed.pathname.replace(/\/+$/, '') + parsed.search;
  } catch {
    return platform + ':' + rawUrl.toLowerCase();
  }
}

export function applyCachedVideoDurations(videos = [], cache = {}) {
  if (!Array.isArray(videos) || !cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return Array.isArray(videos) ? videos : [];
  }
  return videos.map((video) => {
    const key = getDurationCacheKey(video);
    const entry = key ? cache[key] : null;
    const seconds = Math.round(Number(entry?.seconds));
    const source = String(entry?.source || 'metadata');
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_MEDIA_DURATION_SECONDS ||
        !['metadata', 'player'].includes(source)) return video;
    const existing = getDurationEstimate(video);
    const hasTrustedExisting = ['metadata', 'player'].includes(String(video?.durationSource || '')) &&
      Number(video?.durationSec) > 0;
    if (hasTrustedExisting || (!existing.estimated && Number(video?.durationSec) > 0)) return video;
    return {
      ...video,
      duration: formatMediaDuration(seconds),
      durationSec: seconds,
      durationSource: source
    };
  });
}
