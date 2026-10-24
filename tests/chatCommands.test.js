import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSupportedMediaUrl,
  extractSupportedMediaUrls,
  isSupportedMediaUrlMessage,
  parseTwitchPrivmsgLine,
  splitTwitchIrcFrame,
} from '../src/chatCommands.js';

test('Twitch IRC frames are split into every line, including a PING followed by chat messages', () => {
  const lines = splitTwitchIrcFrame(
    'PING :tmi.twitch.tv\r\n' +
    '@badges=;mod=0;display-name=Alice :alice!alice@alice.tmi.twitch.tv PRIVMSG #2o3a :first\r\n' +
    '@badges=moderator/1;mod=1;display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #2o3a :second'
  );
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^PING/);
  assert.equal(parseTwitchPrivmsgLine(lines[1]).text, 'first');
  assert.equal(parseTwitchPrivmsgLine(lines[2]).text, 'second');
});

test('Twitch IRC PRIVMSG tags, login, channel, and full message are parsed separately', () => {
  const parsed = parseTwitchPrivmsgLine(
    '@badges=moderator/1;mod=1;display-name=Some\\sViewer;user-type= :someviewer!someviewer@someviewer.tmi.twitch.tv PRIVMSG #2o3a :check this: https://youtu.be/dQw4w9WgXcQ'
  );
  assert.equal(parsed.login, 'someviewer');
  assert.equal(parsed.channel, '2o3a');
  assert.equal(parsed.tags['display-name'], 'Some Viewer');
  assert.equal(parsed.tags.mod, '1');
  assert.equal(parsed.text, 'check this: https://youtu.be/dQw4w9WgXcQ');
});

test('a supported media URL is recognized when it is the whole chat message', () => {
  assert.equal(
    extractSupportedMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(isSupportedMediaUrlMessage('https://clips.twitch.tv/FunnyClipSlug'), true);
});

test('a supported media URL is extracted from surrounding text and trailing punctuation', () => {
  assert.equal(
    extractSupportedMediaUrl('this one is good: https://youtu.be/dQw4w9WgXcQ).'),
    'https://youtu.be/dQw4w9WgXcQ'
  );
  assert.equal(
    extractSupportedMediaUrl('try this vm.tiktok.com/ZMExample/ please'),
    'https://vm.tiktok.com/ZMExample/'
  );
});

test('all supported platforms are recognized, including no-scheme and mobile YouTube links', () => {
  const examples = [
    ['m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.tiktok.com/@creator/video/1234567890123456789', 'https://www.tiktok.com/@creator/video/1234567890123456789'],
    ['https://www.twitch.tv/2o3a/clip/ClipSlugHere', 'https://www.twitch.tv/2o3a/clip/ClipSlugHere'],
    ['https://clips.twitch.tv/ClipSlugHere', 'https://clips.twitch.tv/ClipSlugHere'],
    ['https://clip.kick.com/ClipSlugHere', 'https://clip.kick.com/ClipSlugHere'],
    ['https://kick.com/2o3a/clips/ClipSlugHere', 'https://kick.com/2o3a/clips/ClipSlugHere'],
  ];
  for (const [input, expected] of examples) {
    assert.equal(extractSupportedMediaUrl(input), expected, input);
  }
});

test('unsupported hosts and ordinary chat are not mistaken for media requests', () => {
  assert.equal(extractSupportedMediaUrl('hello everyone'), '');
  assert.equal(extractSupportedMediaUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(extractSupportedMediaUrl('https://example.com/watch?v=dQw4w9WgXcQ'), '');
});


test('two different video links seconds apart are never parser-throttled or merged', () => {
  const urls = [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/jfKfPfyJRdk',
  ];
  assert.deepEqual(extractSupportedMediaUrls(urls.join('  ')), urls);
  assert.equal(extractSupportedMediaUrl(urls[1]), urls[1]);
  assert.deepEqual(extractSupportedMediaUrls(urls[0] + ' ' + urls[0]), [urls[0]]);
});

test('zero-width chat characters and mixed TikTok/YouTube links are normalized', () => {
  const text = 'please play https://youtu.be/dQw4w9WgXcQ\u200b and vt.tiktok.com/ZMExample/';
  assert.deepEqual(extractSupportedMediaUrls(text), [
    'https://youtu.be/dQw4w9WgXcQ', 'https://vt.tiktok.com/ZMExample/',
  ]);
});
