import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('failed backend requests fall back to a staff-authenticated Firestore transaction', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /await fetch\('\/api\/public-request'/);
  assert.match(app, /ALLOWED_TWITCH_USERS\.has\(normalizeTwitchLogin\(twitchAuth\.username\)\)/);
  assert.match(app, /const committedVersion = await runTransaction\(db/);
  assert.match(app, /lastWriteSource: 'moderator-browser-backup'/);
  assert.match(app, /JSON\.parse\(JSON\.stringify\(\{ \.\.\.localItem, createdAt: at \}\)\)/);
  assert.match(app, /pendingQueueAddsRef\.current\.delete\(itemId\)/);
  assert.match(app, /Firestore moderator backup confirmed the request/);
});

test('stale local write warnings clear when a real cloud snapshot confirms no pending request', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const lastDiagnostic = readStoredValue\(localQueueWriteHealthKey, null\)/);
  assert.match(app, /!pendingQueueAddsRef\.current\.size/);
});

test('YouTube blocked autoplay shows only a small non-obstructing play button', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /onAutoplayBlocked/);
  assert.match(app, /youtubeHasRenderedFrameId/);
  assert.match(app, /pointer-events-none absolute bottom-3 left-3 z-30/);
  assert.match(app, /Play video \(browser blocked autoplay\)/);
  assert.doesNotMatch(app, /Your browser blocked autoplay with sound\. Click once to enable playback/);
});


test('a prior local-only queue request is retried rather than rejected as a duplicate', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /pendingQueueAddsRef\.current\.get\(String\(existingItem\.id\)\)/);
  assert.match(app, /syncAddVideo\(strandedItem, \{ retryOnly: true \}\)/);
  assert.match(app, /lastRequestResult: recovered \? 'recovered_pending_request'/);
  assert.match(app, /return recovered/);
});


test('History requeue confirms Firestore before updating the queue or reporting success', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('  const handleRequeue = async (video) => {');
  const end = app.indexOf('  const handleTogglePin = (video) => {', start);
  assert.ok(start >= 0 && end > start);
  const handler = app.slice(start, end);
  assert.match(handler, /historyRequeueInFlightRef\.current\.has\(id\)/);
  assert.match(handler, /if \(!db \|\| !firebaseUser\)/);
  assert.match(handler, /const updates = buildHistoryRequeuePatch\(/);
  assert.match(handler, /await persistQueuePatches\(new Map\(\[\[id, updates\]\]\), \[\.\.\.videosRef\.current\], false\)/);
  assert.ok(handler.indexOf('await persistQueuePatches') < handler.indexOf('setVideos((previous)'));
  assert.match(handler, /return item\.status === 'watched' \? \{ \.\.\.item, \.\.\.updates \} : item/);
  assert.match(handler, /finally \{/);
  assert.doesNotMatch(handler, /syncUpdateVideo\(/);
});

test('cloud listener only hides duplicate media, never deletes live documents', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /dedupeMediaVideos\(rawRoomList\)/);
  assert.doesNotMatch(app, /deleteDoc\(doc\(db, 'artifacts', appId, 'public', 'data', 'queue_videos', duplicateId\)/);
  assert.match(app, /Remove legacy duplicate|snapshot deduplication decision must never trigger/);
});

test('player quick actions have no duplicate pause, mute or volume slider', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = app.indexOf('{/* Player Quick Action Bar */}');
  const end = app.indexOf('{/* Watch Later Quick Stash */}', start);
  assert.ok(start >= 0 && end > start);
  const bar = app.slice(start, end);
  assert.doesNotMatch(bar, /togglePlaybackFromKeyboard|toggleMuteFromKeyboard|setPlayerVolume/);
  assert.doesNotMatch(bar, /type="range"|aria-label="Player volume"|aria-label="Pause video"|aria-label="Mute video"/);
  assert.match(app, /<TransportNavigation isStaff=\{isStaff\}/);
  assert.match(app, /if \(!event\.repeat\) togglePlaybackFromKeyboard\(\)/);
});
