import React, { useEffect, useRef, useState } from 'react';
import { parseTwitchClipPlayback, hasTwitchClipEnded } from '../twitchPlayback.js';

// The provider SDK has no bundled TypeScript declarations.
declare global { interface Window { Twitch?: any } }
let sdkPromise: Promise<any> | null = null;
function loadSdk() {
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => { sdkPromise = null; reject(new Error('Player timed out')); }, 12000);
    script.src = 'https://player.twitch.tv/js/embed/v1.js';
    script.onload = () => { window.clearTimeout(timeout); window.Twitch?.Player ? resolve(window.Twitch) : reject(new Error('Player unavailable')); };
    script.onerror = () => { window.clearTimeout(timeout); sdkPromise = null; reject(new Error('Player unavailable')); };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

// Twitch clips have no interactive API. A retained source VOD lets the official
// VOD player report real playback position, pause, and completion for the segment.
type Props = {
  video: { id: string; videoId: string; url?: string; title: string };
  volume: number;
  muted: boolean;
  onAudioChange: (volume: number, muted: boolean) => void;
  onEnded: (id: string) => void;
};
export default function TwitchClipPlayer({ video, volume, muted, onAudioChange, onEnded }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const callbacks = useRef({ onEnded, onAudioChange, volume, muted });
  callbacks.current = { onEnded, onAudioChange, volume, muted };
  const [mode, setMode] = useState('loading');
  const [blocked, setBlocked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [segmentCompleted, setSegmentCompleted] = useState(false);
  const replayRef = useRef<(() => void) | null>(null);
  const fallbackAudio = useRef({ id: video.id, muted });
  if (fallbackAudio.current.id !== video.id) fallbackAudio.current = { id: video.id, muted };
  useEffect(() => {
    let disposed = false;
    let timer: number;
    let player: any;
    let completed = false;
    let ready = false;
    const controller = new AbortController();
    setMode('loading');
    setBlocked(false);
    setPaused(false);
    setSegmentCompleted(false);
    const finish = () => {
      if (disposed || completed) return;
      completed = true;
      setSegmentCompleted(true);
      player.pause();
      callbacks.current.onEnded(video.id);
    };
    (async () => {
      try {
        const response = await fetch('/api/media-metadata?playback=1&url=' + encodeURIComponent(video.url || 'https://clips.twitch.tv/' + video.videoId), { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('Source unavailable');
        const source = await response.json();
        const segment = parseTwitchClipPlayback(source);
        if (!segment) throw new Error('Source unavailable');
        const { start, duration } = segment;
        const Twitch = await loadSdk();
        if (disposed) return;
        setMode('vod');
        player = new Twitch.Player(host.current, { video: 'v' + source.videoId, time: `${start}s`, width: '100%', height: '100%', parent: [window.location.hostname], autoplay: true, muted: callbacks.current.muted });
        playerRef.current = player;
        replayRef.current = () => {
          if (disposed) return;
          completed = false;
          setSegmentCompleted(false);
          player.seek(start);
          player.play();
        };
        player.addEventListener(Twitch.Player.READY, () => {
          if (disposed) return;
          ready = true;
          player.setVolume(callbacks.current.volume / 100);
          player.setMuted(callbacks.current.muted);
          player.seek(start);
          player.play();
        });
        player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => { if (!disposed) setBlocked(true); });
        player.addEventListener(Twitch.Player.PLAYING, () => { if (!disposed) { setBlocked(false); setPaused(false); } });
        player.addEventListener(Twitch.Player.PAUSE, () => { if (!disposed) setPaused(true); });
        player.addEventListener(Twitch.Player.ENDED, () => { if (ready && player.getCurrentTime() >= start + duration - 0.5) finish(); });
        timer = window.setInterval(() => {
          if (disposed || !ready || completed) return;
          // Only the player's media clock can finish a clip. A paused, buffering,
          // blocked or hidden player cannot consume a wall-clock countdown.
          if (hasTwitchClipEnded(player.getCurrentTime(), start, duration)) { finish(); return; }
          callbacks.current.onAudioChange(Math.round(player.getVolume() * 100), player.getMuted());
        }, 250);
      } catch {
        if (!disposed) setMode('clip');
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      playerRef.current = null;
      replayRef.current = null;
      try { player?.pause(); } catch { /* Player already removed. */ }
      host.current?.replaceChildren();
    };
  }, [video.id, video.videoId]);
  useEffect(() => {
    try { playerRef.current?.setVolume(volume / 100); playerRef.current?.setMuted(muted); } catch { /* Wait for READY. */ }
  }, [volume, muted]);
  return <div className="absolute inset-0 flex flex-col bg-black">
    <div ref={host} className="min-h-0 flex-1" />
    {mode === 'loading' && <p role="status" className="absolute inset-0 grid place-items-center text-sm text-slate-300">Loading Twitch playback…</p>}
    {mode === 'clip' && <iframe className="absolute inset-0 h-full w-full pb-12" src={`https://clips.twitch.tv/embed?clip=${encodeURIComponent(video.videoId)}&parent=${encodeURIComponent(window.location.hostname)}&autoplay=true&muted=${fallbackAudio.current.muted}`} title={video.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />}
    <div className="relative flex shrink-0 items-center gap-3 bg-slate-950 p-2 text-xs text-slate-200">
      {mode === 'vod' ? <>
        <button type="button" onClick={() => { if (segmentCompleted) replayRef.current?.(); else if (paused || blocked) playerRef.current?.play(); else playerRef.current?.pause(); }} className="rounded bg-purple-700 px-3 py-1.5">{segmentCompleted ? 'Replay clip' : paused || blocked ? 'Play clip' : 'Pause clip'}</button>
        <button type="button" aria-label={muted ? 'Unmute Twitch' : 'Mute Twitch'} onClick={() => onAudioChange(volume, !muted)}>{muted ? 'Unmute' : 'Mute'}</button>
        <input type="range" aria-label="Twitch volume" min="0" max="100" value={volume} onChange={event => onAudioChange(Number(event.target.value), muted)} className="w-24" />
        {blocked && <span role="status">Press Play clip to allow playback with sound.</span>}
      </> : mode === 'clip' ? <span role="status">Source VOD unavailable. Use Twitch’s controls and Next when finished; automatic advance is unavailable.</span> : null}
    </div>
  </div>;
}
