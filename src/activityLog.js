const ACTIVITY_TYPES = new Set(['request_added','play_started','playback_completed','track_skipped','track_replayed','vote_cast','request_removed']);
const cleanText = (value, maxLength = 180) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength);
const normalizeName = (value) => cleanText(value, 64).replace(/^@/, '').toLowerCase();

export function normalizeActivityEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = cleanText(value.id, 140);
  const type = cleanText(value.type, 48);
  const at = Number(value.at);
  if (!id || !ACTIVITY_TYPES.has(type) || !Number.isFinite(at) || at <= 0) return null;
  return {
    id, type, room: normalizeName(value.room || '2o3a') || '2o3a', at,
    sessionId: cleanText(value.sessionId, 120), mediaId: cleanText(value.mediaId, 140),
    title: cleanText(value.title || 'Untitled media', 180), requester: normalizeName(value.requester),
    actor: normalizeName(value.actor), platform: cleanText(value.platform || 'external', 32).toLowerCase(),
    category: cleanText(value.category || 'General', 60) || 'General', source: cleanText(value.source || 'dashboard', 40)
  };
}

export function createActivityEvent({ id, type, room = '2o3a', at = Date.now(), sessionId = '', video = {}, actor = '', source = 'dashboard' } = {}) {
  const timestamp = Number(at);
  const generatedId = id || `activity-${Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return normalizeActivityEvent({
    id: generatedId, type, room, at: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    sessionId, mediaId: video?.id, title: video?.title, requester: video?.requestedBy, actor,
    platform: video?.platform || 'external', category: video?.category || video?.mediaType || 'General', source
  });
}

export function mergeActivityEvents(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      const event = normalizeActivityEvent(item);
      if (event && !byId.has(event.id)) byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function countsFor(items, getValue) {
  const counts = new Map();
  for (const item of items) {
    const value = getValue(item);
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  // Stable sorting keeps equally ranked requesters in first-seen order instead of
  // moving viewer10/viewer11 ahead of viewer2/viewer3 by lexical string comparison.
  return [...counts.entries()].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

export function buildActivityStatistics(events = []) {
  const items = mergeActivityEvents(events);
  const requests = items.filter((event) => event.type === 'request_added');
  const requesters = countsFor(requests, (event) => {
    const name = normalizeName(event.requester);
    return name && name !== 'viewer' && name !== 'unknown' ? name : '';
  });
  return {
    totalEvents: items.length, totalRequests: requests.length,
    uniqueRequesters: new Set(requesters.map((item) => item.label)).size,
    playsStarted: items.filter((event) => event.type === 'play_started').length,
    completed: items.filter((event) => event.type === 'playback_completed').length,
    skipped: items.filter((event) => event.type === 'track_skipped').length,
    replays: items.filter((event) => event.type === 'track_replayed').length,
    votes: items.filter((event) => event.type === 'vote_cast').length,
    removed: items.filter((event) => event.type === 'request_removed').length,
    platforms: countsFor(requests, (event) => event.platform || 'external').slice(0, 4),
    genres: countsFor(requests, (event) => event.category || 'General').slice(0, 4),
    requesters: requesters.slice(0, 10)
  };
}


/**
 * Filters normalized activity events for the Stats board's selectable reporting window.
 * "session" is scoped to this browser tab's current activity session ID.
 */
export function filterActivityEventsByPeriod(events = [], { period = 'lifetime', sessionId = '', now = Date.now() } = {}) {
  const normalized = mergeActivityEvents(events);
  if (period === 'session') {
    const currentSession = String(sessionId || '');
    return currentSession ? normalized.filter((event) => event.sessionId === currentSession) : [];
  }
  if (period === '24h') {
    const currentTime = Number(now) || Date.now();
    const cutoff = currentTime - 24 * 60 * 60 * 1000;
    return normalized.filter((event) => event.at >= cutoff && event.at <= currentTime);
  }
  return normalized;
}
