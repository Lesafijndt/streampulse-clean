export const MAX_MEDIA_DURATION_SECONDS = 31 * 24 * 60 * 60;

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

export function isValidMediaDuration(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_MEDIA_DURATION_SECONDS;
}

function isLegacyPlaceholderDuration(video) {
  if (!video || ['metadata', 'player'].includes(String(video.durationSource || ''))) return false;
  const platform = String(video.platform || '').toLowerCase();
  return (Number(video.durationSec) === 45 && String(video.duration || '') === '00:45' &&
      ['tiktok', 'twitch', 'kick'].includes(platform)) ||
    (Number(video.durationSec) === 225 && ['03:45', '3:45'].includes(String(video.duration || '')));
}

export function videoNeedsDurationLookup(video) {
  if (!video?.id || !video?.url ||
      !['youtube', 'tiktok', 'twitch', 'kick'].includes(String(video.platform || '').toLowerCase())) return false;
  const seconds = Number(video.durationSec) || 0;
  const label = String(video.duration || '').trim();
  const placeholder = isLegacyPlaceholderDuration(video);
  const hasUsefulSeconds = isValidMediaDuration(seconds) && !placeholder;
  const hasUsefulLabel = /^(?:\d+:)?\d{1,2}:\d{2}$/.test(label) &&
    (['metadata', 'player'].includes(String(video.durationSource || '')) ||
      !['00:45', '03:45', '3:45'].includes(label));
  return !(hasUsefulSeconds || hasUsefulLabel);
}

export function getDurationRetryDelayMs(attemptCount) {
  const attempt = Math.max(1, Math.floor(Number(attemptCount) || 1));
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
}

export function shouldRetryDurationLookup(outcome, now = Date.now(), force = false) {
  if (force) return true;
  const status = typeof outcome === 'string' ? outcome : outcome?.status;
  if (status === 'pending' || status === 'found') return false;
  if (status === 'error' || status === 'unavailable') {
    const nextRetryAt = Number(typeof outcome === 'object' ? outcome?.nextRetryAt : 0) || 0;
    return nextRetryAt === 0 || nextRetryAt <= now;
  }
  return true;
}

export function createDurationLookupOutcome({
  status,
  platform = 'external',
  previous = null,
  at = Date.now(),
  reason = '',
  provider = '',
}) {
  const priorAttempts = Math.max(0, Number(previous?.attempts) || 0);
  const base = { status, at, platform: String(platform || 'external').toLowerCase(), attempts: priorAttempts };
  if (provider) base.provider = String(provider).slice(0, 80);
  if (status === 'pending' || status === 'found') return base;
  const attempts = priorAttempts + 1;
  return {
    ...base,
    attempts,
    reason: String(reason || 'The provider did not return a usable duration.').slice(0, 360),
    nextRetryAt: at + getDurationRetryDelayMs(attempts),
  };
}
