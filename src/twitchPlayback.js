export function parseTwitchClipPlayback(source) {
  const start = Number(source?.offsetSeconds);
  const duration = Number(source?.durationSeconds);
  if (source?.available === false || !/^\d+$/.test(String(source?.videoId)) ||
      !Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) return null;
  return { videoId: String(source.videoId), start, duration };
}

export function hasTwitchClipEnded(currentTime, start, duration) {
  return Number.isFinite(currentTime) && currentTime >= start + duration;
}
