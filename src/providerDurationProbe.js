import { isValidMediaDuration } from './durationLookup.js';

// A cued, muted metadata player. Never sends play, changes the main player, or advances a queue.
export function probeYouTubeDuration(videoId, { timeoutMs = 15000, signal } = {}) {
  if (!/^[\w-]{11}$/.test(String(videoId)) || document.hidden || signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const frame = document.createElement('iframe');
    const origin = 'https://www.youtube.com';
    let finished = false, ready = false, timer, interval;
    const finish = seconds => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearInterval(interval);
      window.removeEventListener('message', receive); document.removeEventListener('visibilitychange', visibility);
      signal?.removeEventListener('abort', abort); frame.remove();
      resolve(isValidMediaDuration(seconds) ? Math.round(Number(seconds)) : null);
    };
    const send = (func, args = []) => frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), origin);
    const receive = event => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      let data = event.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
      if (!data || typeof data !== 'object') return;
      if (data.event === 'onError') return finish(null);
      if (isValidMediaDuration(data.info?.duration)) return finish(data.info.duration);
      if (data.event === 'onReady' && !ready) {
        ready = true; send('mute'); send('cueVideoById', [videoId, 0]);
      }
    };
    const abort = () => finish(null);
    const visibility = () => { if (document.hidden) finish(null); };
    const initialize = () => {
      if (finished) return;
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'duration-' + videoId }), origin);
      send('addEventListener', ['onReady']); send('addEventListener', ['onError']);
    };
    frame.title = 'Video duration lookup'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
    frame.dataset.durationProbe = videoId;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:200px;height:200px;pointer-events:none;';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = origin + '/embed/' + encodeURIComponent(videoId) + '?enablejsapi=1&autoplay=0&mute=1&controls=0&origin=' + encodeURIComponent(window.location.origin);
    frame.onload = initialize;
    window.addEventListener('message', receive); document.addEventListener('visibilitychange', visibility);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(null), timeoutMs); interval = setInterval(initialize, 500);
    document.body.appendChild(frame);
  });
}
