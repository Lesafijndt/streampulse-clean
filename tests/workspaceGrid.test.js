import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('widget layout is browser-only, per Twitch account, draggable and resizable', async () => {
  const s = await readFile(new URL('../src/components/WorkspaceGrid.tsx', import.meta.url), 'utf8');
  assert.match(s, /KEY_PREFIX \+ account/);
  assert.match(s, /localStorage\.setItem/);
  assert.match(s, /onDragStart/);
  assert.match(s, /onDrop/);
  assert.match(s, /onPointerDown=\{handleResizeStart\}/);
  assert.doesNotMatch(s, /setDoc|collection\(|firebase/);
});
