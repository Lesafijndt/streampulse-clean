import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('stats board removes platform/category rankings and shows 10 requesters', async () => {
  const s = await read('src/components/StatsBoard.tsx');
  assert.doesNotMatch(s, /Top platform|Top category|function Ranking/);
  assert.match(s, /requesters\.slice\(0, 10\)/);
});

test('moderator-only technical interface is not rendered for streamer', async () => {
  const s = await read('src/App.tsx');
  assert.match(s, /\{isModerator && connectionDetailsExpanded && \(/);
  assert.match(s, /\{isModerator && showSettingsModal && \(/);
  assert.match(s, /\{isModerator && <WorkspacePanel id="stats"/);
  assert.match(s, /\{isModerator && <div className="rounded-xl px-3 py-2">/);
  assert.match(s, /\{isModerator && <div className="mt-1 rounded-xl px-3 py-2">/);
  assert.match(s, /const StatsBoard = lazy\(/);
});

test('moderator-only backend routes reject streamer tokens', async () => {
  const activity = await read('api/activity-log.js');
  const chat = await read('api/twitch/chat-message.js');
  const bot = await read('api/twitch/bot-session.js');
  const login = await read('api/twitch/bot-login.js');
  const logout = await read('server/bot-logout.js');
  assert.match(activity, /new Set\(\['paim_beach_pete'\]\)/);
  assert.match(chat, /new Set\(\['paim_beach_pete'\]\)/);
  assert.match(bot, /'moderator_required'/);
  assert.match(login, /Moderator required/);
  assert.match(logout, /moderator_required/);
});

test('personal cloud profiles only allow owner fields, and shared queue writes remain separate', async () => {
  const s = await read('src/App.tsx');
  const rules = await read('firestore.rules');
  assert.match(s, /\/api\/twitch\/session\?action=preferences/);
  const backend = await read('api/twitch/session.js');
  assert.match(backend, /collection\('user_profiles'\)\.doc\(login\)/);
  assert.match(backend, /if \(preferencesAction\)/);
  assert.match(backend, /sanitizePersonalPreferences\(body\.preferences\)/);
  assert.match(backend, /req\.headers\.origin !== allowedOrigin/);
  assert.match(s, /sanitizePersonalPreferences\(/);
  assert.match(rules, /isPersonalOwner\(login\)/);
  assert.match(rules, /request\.auth\.token\.twitchLogin == login/);
  assert.match(rules, /allow create, update: if isModerator\(\) && channelRoom == '2o3a'/);
});

test('viewer requests process all pasted URLs, are not restricted by account role, and signal failures', async () => {
  const s = await read('src/App.tsx');
  assert.match(s, /extractChatMediaUrls\(rawText/);
  assert.match(s, /for \(const requestText of requests\)/);
  assert.doesNotMatch(s.slice(s.indexOf('const handleIncomingChatCommand ='), s.indexOf('const confirmed = await syncAddVideo(newVideo)')), /sendTwitchChatReply\(/);
  assert.doesNotMatch(s, /if \(role !== 'moderator'\).*handleIncomingChatCommand/);
});

test('video players use provider-correct shells and bounded fallback, not assumed unrestricted autoplay', async () => {
  const app = await read('src/App.tsx');
  const css = await read('src/index.css');
  assert.match(app, /gachi-portrait-shell/);
  assert.match(app, /twitchClipFinishRef\.current/);
  assert.match(app, /setTikTokPlayerState\(\{ requestId: video\.id, status: 'blocked' \}\)/);
  assert.match(app, /onPlayerError/);
  assert.match(css, /\.gachi-player-stage > \.gachi-portrait-shell/);
});

test('audio volume and mute settings never appear in personal cloud profile payloads', async () => {
  const s = await read('src/App.tsx');
  const prefs = await read('src/personalPreferences.js');
  assert.match(s, /'whale-cum:audio:v1:' \+ name/);
  assert.match(prefs, /PERSONAL_FIELDS/);
  assert.doesNotMatch(prefs, /'playerVolume'|'playerMuted'|'widgetLayout'/);
});
