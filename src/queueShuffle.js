const orderValue = (video) => {
  const value = video.queueOrder ?? video.timestamp ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
};

export const queueRequestKey = video => String(video.id) + ':' + String(video.timestamp || video.createdAt || 0);

export function buildUnshuffleQueueTransition(videos, snapshot = []) {
  const original = new Map(snapshot.map((entry, index) => [entry, index]));
  const queue = videos.filter(video => video.status === 'queue').sort((a, b) => orderValue(a) - orderValue(b));
  const movable = queue.filter(video => !video.pinned).sort((a, b) => {
    if (original.size) return (original.get(queueRequestKey(a)) ?? Infinity) - (original.get(queueRequestKey(b)) ?? Infinity) ||
      Number(a.timestamp || 0) - Number(b.timestamp || 0) || String(a.id).localeCompare(String(b.id));
    return Number(b.upvotes || 0) - Number(a.upvotes || 0) || Number(a.timestamp || 0) - Number(b.timestamp || 0) || String(a.id).localeCompare(String(b.id));
  });
  const updates = new Map(); let cursor = 0;
  queue.map(video => video.pinned ? video : movable[cursor++]).forEach((video, index) => {
    if (video.queueOrder !== (index + 1) * 1000) updates.set(video.id, { queueOrder: (index + 1) * 1000 });
  });
  return { updates, nextVideos: videos.map(video => updates.has(video.id) ? { ...video, ...updates.get(video.id) } : video) };
}

export function buildShuffleQueueTransition(videos, random = Math.random, fair = false) {
  const queue = videos.filter((video) => video.status === 'queue').sort((a, b) =>
    orderValue(a) - orderValue(b) || (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) || String(a.id).localeCompare(String(b.id)));
  const movable = queue.filter((video) => !video.pinned);
  for (let i = movable.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [movable[i], movable[j]] = [movable[j], movable[i]];
  }
  if (fair) {
    const buckets = new Map();
    for (const video of movable) {
      const login = String(video.requestedBy || '').trim().replace(/^@/, '').toLowerCase();
      if (!buckets.has(login)) buckets.set(login, []);
      buckets.get(login).push(video);
    }
    const interleaved = [];
    while (interleaved.length < movable.length) {
      for (const bucket of buckets.values()) if (bucket.length) interleaved.push(bucket.shift());
    }
    movable.splice(0, movable.length, ...interleaved);
  }
  let cursor = 0;
  const updates = new Map();
  queue.map((video) => video.pinned ? video : movable[cursor++]).forEach((video, index) => {
    const queueOrder = (index + 1) * 1000;
    if (video.queueOrder !== queueOrder) updates.set(video.id, { queueOrder });
  });
  return {
    nextVideos: videos.map((video) => updates.has(video.id) ? { ...video, ...updates.get(video.id) } : video),
    updates
  };
}
