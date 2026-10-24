function timestampToMilliseconds(value) {
  if (value && typeof value === 'object') {
    if (typeof value.toMillis === 'function') {
      const millis = Number(value.toMillis());
      return Number.isFinite(millis) && millis > 0 ? millis : null;
    }
    if (value instanceof Date) {
      const millis = value.getTime();
      return Number.isFinite(millis) && millis > 0 ? millis : null;
    }
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,16}$/.test(value.trim()))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 100000000000 ? numeric * 1000 : numeric;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function plural(value, unit) {
  return String(value) + ' ' + unit + (value === 1 ? '' : 's') + ' ago';
}

export function formatRelativeTimestamp(value, now = Date.now()) {
  const timestamp = timestampToMilliseconds(value);
  if (!timestamp) return 'time unknown';
  const elapsedSeconds = Math.max(0, Math.floor((Number(now) - timestamp) / 1000));
  if (elapsedSeconds < 10) return 'just now';
  if (elapsedSeconds < 60) return plural(elapsedSeconds, 'second');
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 14) return plural(days, 'day');
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

export function formatAbsoluteTimestamp(value) {
  const timestamp = timestampToMilliseconds(value);
  return timestamp
    ? new Date(timestamp).toLocaleString()
    : 'Original timestamp was not saved for this item';
}
