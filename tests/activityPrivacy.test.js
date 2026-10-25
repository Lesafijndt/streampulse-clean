import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('statistics belong to approved staff while technical diagnostics remain moderator only', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(app, /const \[activityEvents, setActivityEvents\] = useState\(\[\]\)/);
  assert.doesNotMatch(app, /readStoredValue\(roomStorageKey\(channelRoom, 'activity-events'\)/);
  assert.doesNotMatch(app, /writeStoredValue\(roomStorageKey\(channelRoom, 'activity-events'\)/);
  assert.match(app, /if \(!statisticsAccess\) \{\s*activityCloudReadyRef/);
  assert.match(app, /statisticsAccess && <WorkspacePanel id="stats"/);
  assert.match(app, /isModerator && connectionDetailsExpanded/);
  assert.match(app, /'queue_events', String\(event\.id\)/);
  assert.match(rules, /match \/artifacts\/\{appId\}\/public\/data\/queue_events\/\{eventId\}/);
  assert.match(rules, /allow read: if isModerator\(\)/);
  assert.match(rules, /allow create: if isApprovedYediUser\(\)/);
});
