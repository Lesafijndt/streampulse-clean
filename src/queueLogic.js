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
  if (!video || video.durationSource === 'metadata') return false;
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
        watchedAt: 'Just now',
        playedAt: transitionAt,
        nextTrackOverrideId: null
      });
    }
  });
  updatesById.set(String(outgoing.id), {
    status: 'watched',
    watchedAt: 'Just now',
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
  const updates = new Map([
    [String(outgoing.id), { status: 'queue', pinned: false, nextTrackOverrideId: null }],
    [String(previouslyPlayed.id), {
      status: 'playing',
      pinned: false,
      playedAt: now,
      nextTrackOverrideId: String(outgoing.id)
    }]
  ]);
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
