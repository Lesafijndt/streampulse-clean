// Provider codes cannot reliably distinguish an age restriction from an embed ban.
export function playbackFailureMessage(platform, code) {
  if (platform === 'youtube') {
    if (Number(code) === 100) return 'This video was removed or is private. Open the original to check access, or skip it.';
    if ([101, 150].includes(Number(code))) return 'This video cannot play here. Embedding may be disabled, or age, sign-in, or regional restrictions may apply. Open the original and sign in if needed, or skip it.';
    if (Number(code) === 153) return 'The player could not verify this site. Retry, open the original, or skip this video.';
  }
  return 'This video could not play here. It may be unavailable, age-restricted, region-blocked, or require sign-in on its original site. Your request is still here.';
}

const ORIGINS = {
  youtube: ['https://www.youtube.com', 'https://i.ytimg.com'],
  tiktok: ['https://www.tiktok.com'],
  twitch: ['https://clips.twitch.tv', 'https://player.twitch.tv'],
  instagram: ['https://www.instagram.com']
};

// Warm connections only: never mount a second player or fetch signed media URLs.
export function prepareNextConnections(video, document) {
  if (!video || !document) return () => {};
  const links = (ORIGINS[video.platform] || []).map(href => {
    const link = document.createElement('link');
    link.rel = 'preconnect'; link.href = href;
    link.dataset.nextPlayer = 'true';
    document.head.appendChild(link);
    return link;
  });
  return () => links.forEach(link => link.remove());
}

export function queueHealthWarnings(health, { online = true, cloudSynced = true, now = Date.now() } = {}) {
  if (health.loading) return [];
  const warnings = [];
  if (!online) warnings.push('Dashboard offline. Queue updates cannot reach this browser.');
  else if (!cloudSynced) warnings.push('Dashboard queue sync is not confirmed. Check storage before relying on this view.');
  if (!health.active) warnings.push('Twitch intake is not confirmed active. New chat requests may not arrive.');
  if (health.receiptCode && !['ok', 'unknown'].includes(health.receiptCode)) warnings.push('Queue delivery records could not be read. Check storage access.');
  if (/failed|error|buffered/.test(health.lastWebhookResult || '')) warnings.push('The latest request delivery needs attention; a successful save is not confirmed.');
  if (health.lastWebhookResult === 'queued' && health.lastWebhookAt > (health.lastQueueWriteAt || 0) + 60_000) warnings.push('The latest accepted request has no matching confirmed queue write.');
  if (health.active && health.lastWebhookAt && now - health.lastWebhookAt > 30 * 60_000) warnings.push('No request delivery recorded in 30 minutes. Chat may be quiet; this alone does not prove a fault.');
  return warnings;
}
