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

test('YouTube blocked autoplay shows a visible thumbnail and button', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /onAutoplayBlocked/);
  assert.match(app, /youtubeHasRenderedFrameId/);
  assert.match(app, /currentVideo\.thumbnail/);
  assert.match(app, /Click to start video/);
  assert.match(app, /browser blocked autoplay with sound/);
});
