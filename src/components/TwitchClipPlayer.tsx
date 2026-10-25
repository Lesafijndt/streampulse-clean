import React, { useEffect, useMemo, useRef, useState } from 'react';
import { parseTwitchClipPlayback, hasTwitchClipEnded } from '../twitchPlayback.js';
import { getPlaybackGeneration } from '../playerBridge.js';

declare global { interface Window { Twitch?: any } }
let sdkPromise: Promise<any> | null = null;
function loadSdk() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { sdkPromise = null; reject(new Error('Player unavailable')); };
    const timeout = window.setTimeout(fail, 12000);
    script.src = 'https://player.twitch.tv/js/embed/v1.js';
    script.onload = () => { window.clearTimeout(timeout); window.Twitch?.Player ? resolve(window.Twitch) : fail(); };
    script.onerror = () => { window.clearTimeout(timeout); fail(); };
    document.head.appendChild(script);
  });
  return sdkPromise;
}
type Props = {
  video: { id: string; videoId: string; url?: string; title: string; timestamp?: number; playedAt?: number };
  storageKey?: string;
  volume: number;
  muted: boolean;
  onAudioChange: (volume: number, muted: boolean) => void;
  onEnded: (id: string) => void;
};
export default function TwitchClipPlayer({ video, storageKey, volume, muted, onAudioChange, onEnded }: Props) {
  const generation = getPlaybackGeneration(video);
  const key = storageKey || 'twitch-playback-v1-' + generation;
  const host = useRef<HTMLDivElement>(null);
  const native = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);
  const callbacks = useRef({ onEnded, onAudioChange, volume, muted });
  callbacks.current = { onEnded, onAudioChange, volume, muted };
  const intent = useRef({ paused: false, seconds: 0 });
  const completed = useRef(false);
  const started = useRef(false);
  const fallbackAudio = useMemo(() => muted, [generation]);
  const [mode, setMode] = useState('loading');
  const [mediaUrl, setMediaUrl] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setAttempt(0); }, [generation]);
  const [blocked, setBlocked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [segmentCompleted, setSegmentCompleted] = useState(false);
  const replayRef = useRef<(() => void) | null>(null);
  const persist = () => { try { sessionStorage.setItem(key, JSON.stringify(intent.current)); } catch { /* Storage disabled. */ } };
  const choosePaused = (value: boolean) => { intent.current.paused = value; setPaused(value); persist(); };
  const finish = () => {
    if (completed.current || intent.current.paused || !started.current) return;
    completed.current = true;
    setSegmentCompleted(true);
    callbacks.current.onEnded(video.id);
  };
  const playNative = () => {
    if (intent.current.paused || !native.current) return;
    const promise = native.current.play();
    promise?.catch(() => { if (native.current && !intent.current.paused) setBlocked(true); });
  };
  useEffect(() => {
    let disposed = false;
    let timer: number;
    let player: any;
    let ready = false;
    let retries = 0;
    const retryTimers: number[] = [];
    const controller = new AbortController();
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
      intent.current = { paused: saved.paused === true, seconds: Math.max(0, Number(saved.seconds) || 0) };
    } catch { intent.current = { paused: false, seconds: 0 }; }
    setPaused(intent.current.paused);
    setMode('loading');setBlocked(false);setSegmentCompleted(false);
    completed.current = false; started.current = false;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      if (native.current) { if (intent.current.paused) native.current.pause(); else playNative(); }
      if (ready && player) { if (intent.current.paused) player.pause(); else player.play(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    (async () => {
      try {
        const response = await fetch('/api/media-metadata?playback=1' + (attempt ? '&refresh=1' : '') + '&url=' + encodeURIComponent(video.url || 'https://clips.twitch.tv/' + video.videoId), { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Source unavailable');
        const source = await response.json();
        if (disposed) return;
        if (source.available !== false && source.mode === 'direct' && /^https:\/\//.test(source.mediaUrl || '')) {
          setMediaUrl(source.mediaUrl);setMode('direct');return;
        }
        const segment = parseTwitchClipPlayback(source);
        if (!segment) throw new Error('Source unavailable');
        const { start, duration } = segment;
        const Twitch = await loadSdk();
        if (disposed) return;
        setMode('vod');
        const position = Math.min(start + duration, start + intent.current.seconds);
        player = new Twitch.Player(host.current, { video: 'v' + source.videoId, time: `${position}s`, width: '100%', height: '100%', parent: [window.location.hostname], autoplay: !intent.current.paused, muted: callbacks.current.muted });
        playerRef.current = player;
        replayRef.current = () => {
          if (disposed) return;
          completed.current = false; started.current = false; intent.current.seconds = 0;
          setSegmentCompleted(false);choosePaused(false);player.seek(start);player.play();
        };
        const restore = () => {
          if (disposed || !ready) return;
          player.setVolume(callbacks.current.volume / 100);player.setMuted(callbacks.current.muted);
          if (intent.current.paused) player.pause();
          if (Math.abs(player.getCurrentTime() - position) > 1) player.seek(position);
          if (!intent.current.paused && document.visibilityState !== 'hidden') player.play();
        };
        player.addEventListener(Twitch.Player.READY, () => {
          if (disposed) return;
          ready = true;restore();
          [500, 1300, 2500].forEach(delay => retryTimers.push(window.setTimeout(() => {
            if (disposed || started.current || intent.current.paused || document.visibilityState === 'hidden') return;
            retries++;restore();if (retries === 3 && !started.current) setBlocked(true);
          }, delay)));
        });
        player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => { if (!disposed) setBlocked(true); });
        player.addEventListener(Twitch.Player.PLAYING, () => {
          if (disposed) return;
          if (intent.current.paused && !started.current && document.activeElement !== host.current?.querySelector('iframe')) { player.pause();return; }
          if (intent.current.paused) choosePaused(false);
          started.current = true;setBlocked(false);setPaused(false);
        });
        player.addEventListener(Twitch.Player.PAUSE, () => {
          if (!disposed && started.current && !completed.current && document.visibilityState !== 'hidden') {
            intent.current.seconds = Math.max(0, player.getCurrentTime() - start);choosePaused(true);
          }
        });
        player.addEventListener(Twitch.Player.ENDED, () => { if (!disposed && ready && hasTwitchClipEnded(player.getCurrentTime(), start, duration)) finish(); });
        timer = window.setInterval(() => {
          if (disposed || !ready || completed.current) return;
          const time = player.getCurrentTime();
          if (started.current && !intent.current.paused && hasTwitchClipEnded(time, start, duration)) { finish();player.pause();return; }
          if (time >= start && started.current) { intent.current.seconds = time - start;persist(); }
          if (started.current) callbacks.current.onAudioChange(Math.round(player.getVolume() * 100), player.getMuted());
        }, 250);
      } catch { if (!disposed) setMode('clip'); }
    })();
    return () => {
      disposed = true;controller.abort();window.clearInterval(timer);
      retryTimers.forEach(window.clearTimeout);document.removeEventListener('visibilitychange', onVisible);
      playerRef.current = null;replayRef.current = null;
      try { player?.pause(); } catch { /* Player removed. */ }
      host.current?.replaceChildren();
    };
  }, [generation, key, attempt]);
  useEffect(() => {
    if (native.current) { native.current.volume = volume / 100;native.current.muted = muted; }
    try { playerRef.current?.setVolume(volume / 100);playerRef.current?.setMuted(muted); } catch { /* Wait for READY. */ }
  }, [volume, muted, mode]);
  const toggle = () => {
    if (segmentCompleted) {
      if (mode === 'vod') { replayRef.current?.();return; }
      completed.current = false;intent.current.seconds = 0;setSegmentCompleted(false);
      if (native.current) native.current.currentTime = 0;
      choosePaused(false);playNative();return;
    }
    if (paused || blocked) { choosePaused(false);mode === 'direct' ? playNative() : playerRef.current?.play(); }
    else { choosePaused(true);mode === 'direct' ? native.current?.pause() : playerRef.current?.pause(); }
  };
  return <div className="absolute inset-0 flex flex-col bg-black">
    <div ref={host} className={mode === 'vod' ? 'min-h-0 flex-1' : 'hidden'} />
    {mode === 'loading' && <p role="status" className="min-h-0 flex-1 grid place-items-center text-sm text-slate-300">Loading Twitch playback…</p>}
    {mode === 'direct' && <video ref={native} src={mediaUrl} className="min-h-0 w-full flex-1 object-contain" controls playsInline preload="auto" aria-label={video.title}
      onLoadedMetadata={() => {
        const media = native.current;if (!media) return;
        media.volume = callbacks.current.volume / 100;media.muted = callbacks.current.muted;
        if (intent.current.seconds > 0 && intent.current.seconds < media.duration) media.currentTime = intent.current.seconds;
        if (intent.current.paused) media.pause();else playNative();
      }}
      onCanPlay={() => { if (!started.current && !intent.current.paused) playNative(); }}
      onPlay={() => { if (intent.current.paused) choosePaused(false); }}
      onPlaying={() => { if (intent.current.paused) { native.current?.pause();return; } started.current = true;setPaused(false);setBlocked(false); }}
      onPause={() => { if (started.current && !completed.current && !native.current?.ended && !native.current?.error && document.visibilityState !== 'hidden') choosePaused(true); }}
      onTimeUpdate={() => { if (native.current && started.current) { intent.current.seconds = native.current.currentTime;persist(); } }}
      onVolumeChange={() => { if (native.current && started.current) callbacks.current.onAudioChange(Math.round(native.current.volume * 100), native.current.muted); }}
      onEnded={finish}
      onError={() => { if (!attempt) setAttempt(1);else setMode('clip'); }} />}
    {mode === 'clip' && <iframe className="min-h-0 w-full flex-1" src={`https://clips.twitch.tv/embed?clip=${encodeURIComponent(video.videoId)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=${!intent.current.paused}&muted=${fallbackAudio}`} title={video.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />}
    <div className="relative flex shrink-0 flex-wrap items-center gap-3 bg-slate-950 p-2 text-xs text-slate-200">
      {mode === 'vod' || mode === 'direct' ? <>
        <button type="button" onClick={toggle} className="rounded bg-purple-700 px-3 py-1.5">{segmentCompleted ? 'Replay clip' : paused || blocked ? 'Play clip' : 'Pause clip'}</button>
        <button type="button" aria-label={muted ? 'Unmute Twitch' : 'Mute Twitch'} onClick={() => onAudioChange(volume, !muted)}>{muted ? 'Unmute' : 'Mute'}</button>
        <label className="flex items-center gap-2">Volume {volume}%<input type="range" aria-label="Twitch volume" min="0" max="100" value={volume} onChange={event => onAudioChange(Number(event.target.value), muted)} className="w-24" /></label>
        {blocked && <span role="status">Press Play clip to allow playback with sound.</span>}
      </> : mode === 'clip' ? <span role="status">Controllable playback unavailable. Use Twitch’s controls and Next when finished; automatic advance and saved pause/volume are unavailable.</span> : null}
    </div>
  </div>;
}
