const TIKTOK_ORIGIN = 'https://www.tiktok.com';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const TIKTOK_COMMANDS = new Set(['play', 'pause', 'mute', 'unMute', 'seek', 'setVolume']);
const YOUTUBE_COMMANDS = new Set(['addEventListener','playVideo','pauseVideo','mute','unMute','setVolume','seekTo','getCurrentTime','getDuration','getVolume','getPlayerState','isMuted']);

export function postTikTokPlayerCommand(target, type, value = null) {
  if (!target || typeof target.postMessage !== 'function' || !TIKTOK_COMMANDS.has(type)) return false;
  try { target.postMessage({ type, value, 'x-tiktok-player': true }, TIKTOK_ORIGIN); return true; }
  catch { return false; }
}

export function postYouTubePlayerCommand(target, command, args = []) {
  if (!target || typeof target.postMessage !== 'function' || !YOUTUBE_COMMANDS.has(command) || !Array.isArray(args)) return false;
  try { target.postMessage(JSON.stringify({ event: 'command', func: command, args }), YOUTUBE_ORIGIN); return true; }
  catch { return false; }
}


/**
 * Restore only the state the viewer had before the tab was hidden.
 * Intentionally never returns a play command: returning to a tab must not
 * restart media that the viewer paused.
 */
export function getVisibilityRestoreCommands(platform, { paused = false, muted = null } = {}) {
  const commands = [];
  if (paused) {
    if (platform === 'youtube') commands.push('pauseVideo');
    else if (platform === 'tiktok') commands.push('pause');
  }
  if (muted === true) commands.push('mute');
  else if (muted === false) commands.push(platform === 'youtube' ? 'unMute' : platform === 'tiktok' ? 'unMute' : '');
  return commands.filter(Boolean);
}
