import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlaybackCompletionTracker } from '../src/playerBridge.js';
import { buildTikTokPlayerUrl, getVisibilityRestoreActions, getVisibilityRestoreCommands, postTikTokPlayerCommand, postYouTubePlayerCommand, shouldAutoUnmuteTikTok, shouldIgnoreTikTokStartupMute } from '../src/playerBridge.js';

test('provider ended overrides a preceding pause and is latched across replay notifications', () => {
  const tracker = createPlaybackCompletionTracker();
  assert.equal(tracker.observe({ state: 1, currentTime: 2.9, duration: 3 }), false);
  assert.equal(tracker.observe({ state: 2, currentTime: 0, paused: true }), false);
  assert.equal(tracker.observe({ state: 0, paused: true }), true);
  for (const state of [0, 1, 0, 2, 0]) assert.equal(tracker.observe({ state }), false);
  assert.equal(createPlaybackCompletionTracker().observe({ state: 0, paused: true }), true);
});

test('completion fallback requires advancing provider time at its actual duration while playing', () => {
  const tracker = createPlaybackCompletionTracker();
  assert.equal(tracker.observe({ state: 1, currentTime: 2.9, duration: 3 }), false);
  assert.equal(tracker.observe({ currentTime: 0, duration: 3 }), false, 'rewind is not completion');
  assert.equal(tracker.observe({ state: 2, currentTime: 3, duration: 3, paused: true }), false);
  assert.equal(tracker.observe({ state: 1, currentTime: 2, duration: 3 }), false);
  assert.equal(tracker.observe({ currentTime: 3, duration: 3 }), true);
  assert.equal(tracker.observe({ state: 0 }), false);
});

test('TikTok commands are allowlisted and target the official embed origin', () => {
  const messages = []; const target = { postMessage: (data, origin) => messages.push({ data, origin }) };
  assert.equal(postTikTokPlayerCommand(target, 'pause'), true);
  assert.equal(postTikTokPlayerCommand(target, 'mute'), true);
  assert.equal(postTikTokPlayerCommand(target, 'unMute'), true);
  assert.equal(postTikTokPlayerCommand(target, 'executeArbitraryCode'), false);
  assert.equal(messages.length, 3); assert.equal(messages[0].origin, 'https://www.tiktok.com');
  assert.deepEqual(messages[0].data, { type: 'pause', value: null, 'x-tiktok-player': true });
  assert.deepEqual(messages[2].data, { type: 'unMute', value: null, 'x-tiktok-player': true });
});

test('YouTube commands use the expected IFrame Player API message format', () => {
  const messages = []; const target = { postMessage: (data, origin) => messages.push({ data, origin }) };
  assert.equal(postYouTubePlayerCommand(target, 'playVideo'), true);
  assert.equal(postYouTubePlayerCommand(target, 'pauseVideo'), true);
  assert.equal(postYouTubePlayerCommand(target, 'unknownCommand'), false);
  assert.equal(messages.length, 2); assert.equal(messages[0].origin, 'https://www.youtube.com');
  assert.deepEqual(JSON.parse(messages[0].data), { event: 'command', func: 'playVideo', args: [] });
});

test('visibility restoration keeps a paused YouTube video paused and restores its prior audio state', () => {
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: true, muted: false }), ['pauseVideo', 'unMute']);
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: true, muted: true }), ['pauseVideo', 'mute']);
});

test('visibility restoration resumes playback only when the viewer had not paused it', () => {
  assert.deepEqual(getVisibilityRestoreCommands('youtube', { paused: false, muted: false }), ['playVideo', 'unMute']);
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: false, muted: false }), ['play', 'unMute']);
});

test('TikTok visibility restoration honors explicit mute and pause preferences', () => {
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: true, muted: true }), ['pause', 'mute']);
  assert.deepEqual(getVisibilityRestoreCommands('tiktok', { paused: true, muted: false }), ['pause', 'unMute']);
});

test('visibility restoration seeks YouTube to the previous timestamp before re-pausing', () => {
  assert.deepEqual(getVisibilityRestoreActions('youtube', { paused: true, muted: false, currentTime: 83.25 }), [
    { command: 'pauseVideo' },
    { command: 'seekTo', args: [83.25, true] },
    { command: 'unMute' },
  ]);
});

test('visibility restoration uses TikTok seekTo seconds and keeps a paused video paused and muted', () => {
  assert.deepEqual(getVisibilityRestoreActions('tiktok', { paused: true, muted: true, currentTime: 21 }), [
    { command: 'pause' },
    { command: 'seekTo', value: 21 },
    { command: 'mute' },
  ]);
});

test('visibility restoration seeks and resumes an actively playing YouTube video', () => {
  assert.deepEqual(getVisibilityRestoreActions('youtube', { paused: false, muted: false, currentTime: 83.25 }), [
    { command: 'seekTo', args: [83.25, true] },
    { command: 'playVideo' },
    { command: 'unMute' },
  ]);
});

test('visibility restoration seeks and resumes an actively playing TikTok video', () => {
  assert.deepEqual(getVisibilityRestoreActions('tiktok', { paused: false, muted: true, currentTime: 21 }), [
    { command: 'seekTo', value: 21 },
    { command: 'play' },
    { command: 'mute' },
  ]);
});

test('visibility restoration does not seek when no reliable playback position is known', () => {
  assert.deepEqual(getVisibilityRestoreActions('youtube', { paused: true, muted: true, currentTime: 0 }), [
    { command: 'pauseVideo' },
    { command: 'mute' },
  ]);
});

test('TikTok bridge forwards the target timestamp for seekTo', () => {
  const messages = [];
  const target = { postMessage: (data, origin) => messages.push({ data, origin }) };
  assert.equal(postTikTokPlayerCommand(target, 'seekTo', 42.5), true);
  assert.deepEqual(messages[0], {
    data: { type: 'seekTo', value: 42.5, 'x-tiktok-player': true },
    origin: 'https://www.tiktok.com',
  });
});


test('TikTok embeds autoplay while keeping volume controls enabled', () => {
  const activeUrl = new URL(buildTikTokPlayerUrl('1234567890123456789'));
  assert.equal(activeUrl.searchParams.get('autoplay'), '1');
  assert.equal(activeUrl.searchParams.get('muted'), '0');
  assert.equal(activeUrl.searchParams.get('controls'), '1');

  const pausedUrl = new URL(buildTikTokPlayerUrl('1234567890123456789', { paused: true }));
  assert.equal(pausedUrl.searchParams.get('autoplay'), '0');
  assert.equal(pausedUrl.searchParams.get('muted'), '0');
  assert.equal(buildTikTokPlayerUrl(''), '');
});


test('TikTok iframe source stays memoized across playback-state renders', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /const tiktokPlayerSrc = useMemo/);
  assert.match(appSource, /src=\{tiktokPlayerSrc\}/);
  assert.doesNotMatch(appSource, /src=\{buildTikTokPlayerUrl/);
});


test('TikTok startup attempts to unmute unless the viewer explicitly chose mute', () => {
  assert.equal(shouldAutoUnmuteTikTok({ mutedIntent: null, mutePreference: 'auto' }), true);
  assert.equal(shouldAutoUnmuteTikTok({ mutedIntent: false, mutePreference: 'unmuted' }), true);
  assert.equal(shouldAutoUnmuteTikTok({ mutedIntent: true, mutePreference: 'muted' }), false);
  assert.equal(shouldAutoUnmuteTikTok({ mutedIntent: null, mutePreference: 'muted' }), false);
});

test('TikTok transient autoplay mute reports do not overwrite the viewer preference during startup', () => {
  assert.equal(shouldIgnoreTikTokStartupMute({
    muted: true, startupMuteGuardActive: true, startupAudioConfirmed: false, explicitMutePreference: 'auto',
  }), true);
  assert.equal(shouldIgnoreTikTokStartupMute({
    muted: true, startupMuteGuardActive: true, startupAudioConfirmed: false, explicitMutePreference: 'unmuted',
  }), true);
  assert.equal(shouldIgnoreTikTokStartupMute({
    muted: true, startupMuteGuardActive: true, startupAudioConfirmed: false, explicitMutePreference: 'muted',
  }), false);
  assert.equal(shouldIgnoreTikTokStartupMute({
    muted: true, startupMuteGuardActive: true, startupAudioConfirmed: true, explicitMutePreference: 'auto',
  }), false);
  assert.equal(shouldIgnoreTikTokStartupMute({
    muted: false, startupMuteGuardActive: true, startupAudioConfirmed: false, explicitMutePreference: 'auto',
  }), false);
});

test('TikTok mute intent is isolated from legacy autoplay mute reports and startup unmute is retried', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /player-tiktok-mute-intent-v1-/);
  assert.match(appSource, /shouldIgnoreTikTokStartupMute/);
  assert.match(appSource, /requestStartupUnmute/);
  assert.match(appSource, /tiktokAudioStateRef/);
});

test('completion retains provider duration across partial time reports and never borrows it across requests', () => {
 const tracker = createPlaybackCompletionTracker();
 assert.equal(tracker.observe({duration:3}),false);
 assert.equal(tracker.observe({state:1,currentTime:1}),false);
 assert.equal(tracker.observe({currentTime:3}),true);
 assert.equal(tracker.observe({state:0}),false);
 const paused = createPlaybackCompletionTracker();paused.observe({duration:3,state:1,currentTime:1});
 assert.equal(paused.observe({state:2,currentTime:3,paused:true}),false);
 assert.equal(createPlaybackCompletionTracker().observe({state:1,currentTime:300}),false);
});

test('completion joins final advancing time with a later provider duration', () => {
  for (const finalUpdate of [{ duration: 3 }, { duration: 3, currentTime: 3 }]) {
    const tracker = createPlaybackCompletionTracker();
    assert.equal(tracker.observe({ state: 1, currentTime: 2.75 }), false);
    assert.equal(tracker.observe({ currentTime: 3 }), false);
    assert.equal(tracker.observe({ currentTime: 3 }), false, 'repeated final sample retains progress evidence');
    assert.equal(tracker.observe(finalUpdate), true, 'late duration must recheck the actual final position');
    assert.equal(tracker.observe({ state: 0 }), false, 'later ENDED must not complete twice');
  }
});

test('late duration cannot complete a single sample, paused seek, buffering seek, or rewind', () => {
  const sequences = [
    [{ state: 1, currentTime: 3 }],
    [{ state: 1, currentTime: 2 }, { currentTime: 3 }, { state: 2 }, { state: 1, currentTime: 3 }],
    [{ state: 1, currentTime: 2 }, { state: 2, currentTime: 2 }, { currentTime: 3 }, { state: 1, currentTime: 3 }],
    [{ state: 1, currentTime: 2 }, { state: 3 }, { currentTime: 3 }, { state: 1, currentTime: 3 }],
    [{ state: 1, currentTime: 2 }, { currentTime: 3 }, { paused: true }, { state: 1, currentTime: 3 }],
    [{ state: 1, currentTime: 2 }, { currentTime: 3 }, { currentTime: 0 }],
    [{ state: 1, currentTime: 2 }, { currentTime: 3 }, { currentTime: 2.99 }],
  ];
  for (const sequence of sequences) {
    const tracker = createPlaybackCompletionTracker();
    for (const observation of sequence) assert.equal(tracker.observe(observation), false);
    assert.equal(tracker.observe({ duration: 3 }), false, JSON.stringify(sequence));
    assert.equal(tracker.observe({ currentTime: 3 }), false, 'stationary end or first sample after rewind is not completion');
  }
});

test('missing or malformed times never create forward playback evidence', () => {
  for (const currentTime of [null, '', ' ', false, true, [], {}, NaN, Infinity, -1]) {
    const tracker = createPlaybackCompletionTracker();
    assert.equal(tracker.observe({ state: 1, currentTime, duration: 3 }), false);
    assert.equal(tracker.observe({ currentTime: 3 }), false, String(currentTime));
  }
});
