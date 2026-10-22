const TIKTOK_ORIGIN = 'https://www.tiktok.com';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const TIKTOK_COMMANDS = new Set(['play', 'pause', 'mute', 'unMute', 'seekTo', 'setVolume']);

/** Build a TikTok player URL that can start automatically without audio. */
export function buildTikTokPlayerUrl(videoId, { paused = false } = {}) {
  const id = String(videoId || '').trim();
  if (!id) return '';
  // Muted autoplay is more reliable in browsers than relying only on a postMessage
  // sent after onPlayerReady. The app unmutes after playback starts when appropriate.
  const autoplay = paused ? 0 : 1;
  return `https://www.tiktok.com/player/v1/${encodeURIComponent(id)}?autoplay=${autoplay}&muted=1&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&description=0&music_info=0&closed_caption=0&native_context_menu=0&rel=0`;
}
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
 * Restore the viewer's previous play/pause and audio state after a tab switch.
 * A video that was playing should resume; a deliberate pause stays paused.
 */
export function getVisibilityRestoreCommands(platform, { paused = false, muted = null } = {}) {
  const commands = [];
  if (paused) {
    if (platform === 'youtube') commands.push('pauseVideo');
    else if (platform === 'tiktok') commands.push('pause');
  } else {
    if (platform === 'youtube') commands.push('playVideo');
    else if (platform === 'tiktok') commands.push('play');
  }
  if (muted === true) commands.push('mute');
  else if (muted === false) commands.push(platform === 'youtube' ? 'unMute' : platform === 'tiktok' ? 'unMute' : '');
  return commands.filter(Boolean);
}


/** Build ordered player commands to restore the prior position and controls after tab return. */
export function getVisibilityRestoreActions(platform, { paused = false, muted = null, currentTime = 0 } = {}) {
  const actions = [];
  const seconds = Number(currentTime);
  // Pause first so seeking after an iframe resumes from an unstarted state does not
  // briefly start playback when the viewer explicitly left it paused.
  if (paused) {
    if (platform === 'youtube') actions.push({ command: 'pauseVideo' });
    else if (platform === 'tiktok') actions.push({ command: 'pause' });
  }
  if (Number.isFinite(seconds) && seconds > 0.5) {
    if (platform === 'youtube') actions.push({ command: 'seekTo', args: [seconds, true] });
    else if (platform === 'tiktok') actions.push({ command: 'seekTo', value: seconds });
  }
  // Seek first, then resume videos that were active before the tab switch.
  if (!paused) {
    if (platform === 'youtube') actions.push({ command: 'playVideo' });
    else if (platform === 'tiktok') actions.push({ command: 'play' });
  }
  if (muted === true) actions.push({ command: 'mute' });
  else if (muted === false && (platform === 'youtube' || platform === 'tiktok')) actions.push({ command: 'unMute' });
  return actions;
}
