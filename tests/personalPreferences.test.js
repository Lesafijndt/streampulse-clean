import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePersonalPreferences } from '../src/personalPreferences.js';

test('user preferences never contain local-only layout or player audio controls', () => {
  assert.deepEqual(sanitizePersonalPreferences({
    activeTab: 'queue', sortBy: 'priority', widgetLayout: { x: 2 },
    mute: false, volume: 100, playerVolume: 25, playerMuted: true,
    searchQuery: 'word',
  }), { activeTab: 'queue', sortBy: 'priority', searchQuery: 'word' });
});
