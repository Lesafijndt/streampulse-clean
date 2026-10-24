import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizePersonalPreferences } from '../src/personalPreferences.js';

test('profile validation preserves account playback settings but never layout or audio', () => {
  assert.deepEqual(sanitizePersonalPreferences({
    streamSettings: { autoPlayNext: false, queueOpen: false, allowTikTok: true,
      maxDurationMinutes: 10, volume: 100, muted: true },
    widgetLayout: { stats: [0, 0] },
  }), { streamSettings: { autoPlayNext: false, allowTikTok: true, maxDurationMinutes: 10 } });
});

test('shared room storage only contains shared queue availability, not personal preferences', async () => {
  const s = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(s, /streamSettings: \{ queueOpen: streamSettings\.queueOpen \}/);
  assert.doesNotMatch(s, /writeStoredValue\(roomStorageKey\(channelRoom, 'settings'\), streamSettings\)/);
  assert.match(s, /isModerator && showSettingsModal/);
  assert.match(s, /if \(prefs\.streamSettings\)/);
});
