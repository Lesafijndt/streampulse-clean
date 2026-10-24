import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the moderator exclusively owns queue settings and technical setup', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const isModerator = twitchAuth\.authenticated && normalizeTwitchLogin\(twitchAuth\.username\) === 'paim_beach_pete'/);
  assert.match(app, /const canConfigureCloudChat = isModerator/);
  assert.match(app, /\{isModerator && showSettingsModal && \(/);
  assert.match(app, /\{isModerator && showLayoutCustomizer && \(/);
  assert.match(app, /\{isModerator && \(\s*<button type="button" onClick=\{\(\) => \{ setTopMenuOpen\(false\); setShowSettingsModal\(true\)/);
  assert.match(app, /<QueueVideoCard[\s\S]*?isStaff=\{isModerator\}/);
  assert.match(app, /Twitch may be holding normal viewers' links/);
  assert.match(app, /https:\/\/www\.twitch\.tv\/moderator\/2o3a/);
});

test('the streamer retains playback transport but does not own chat intake setup', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../api/twitch/eventsub-setup.js', import.meta.url), 'utf8');
  assert.match(app, /<TransportNavigation isStaff=\{isStaff\}/);
  assert.match(api, /staff\.login !== MODERATOR_LOGIN/);
  assert.match(api, /code: 'moderator_required'/);
  assert.match(api, /Only paim_beach_pete can configure cloud Twitch chat intake/);
  assert.doesNotMatch(app, /Authorize 2o3a for cloud chat/);
  assert.doesNotMatch(api, /Reload the streamer dashboard to retry setup/);
});
