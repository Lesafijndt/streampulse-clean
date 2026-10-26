const orderValue = (video) => {
  const value = video.queueOrder ?? video.timestamp ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
};

export function buildShuffleQueueTransition(videos, random = Math.random) {
  const queue = videos.filter((video) => video.status === 'queue').sort((a, b) =>
    orderValue(a) - orderValue(b) || (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0) || String(a.id).localeCompare(String(b.id)));
  const movable = queue.filter((video) => !video.pinned);
  for (let i = movable.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [movable[i], movable[j]] = [movable[j], movable[i]];
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
