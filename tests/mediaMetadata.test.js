import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationFromHtml, parseDurationFromPlayerResponse, parseIso8601Duration, parsePageMetadata } from '../api/media-metadata.js';
import { MAX_MEDIA_DURATION_SECONDS, isValidMediaDuration } from '../src/durationLookup.js';

test('TikTok metadata selects the requested item instead of recommended videos', () => {
  const html = '<script id="SIGI_STATE">' + JSON.stringify({ ItemModule: {
    wrong: { desc: 'Recommended video', video: { duration: 99 } },
    wanted: { desc: 'Actual caption', video: { duration: 37, cover: 'https://example.com/image.jpg' } }
  } }) + '</script>';
  assert.deepEqual(parsePageMetadata(html, 'wanted'), { title: 'Actual caption', durationSec: 37, thumbnailUrl: 'https://example.com/image.jpg', classificationMetadata:{version:1,authorName:'',channelId:'',description:'Actual caption',sourceCategory:'',tags:[]} });
  assert.equal(parsePageMetadata('<meta property="og:title" content="TikTok - Make Your Day">').title, '');
  assert.equal(parsePageMetadata('<meta property="og:title" content="A &amp; B">').title, 'A & B');
  const missing = '<script id="SIGI_STATE">' + JSON.stringify({ ItemModule: {
    wrong: { desc: 'Recommended', video: { duration: 99 } },
    wanted: { desc: 'Target without duration', video: {} },
    untitled: { video: { duration: 12 } }
  } }) + '</script>';
  assert.equal(parsePageMetadata(missing, 'wanted').durationSec, null);
  assert.equal(parsePageMetadata(missing, 'absent').durationSec, null);
  assert.equal(parsePageMetadata(missing, 'untitled').durationSec, 12);
});

test('YouTube ISO-8601 duration values are parsed correctly', () => {
  assert.equal(parseIso8601Duration('PT3M45S'), 225);
  assert.equal(parseIso8601Duration('PT1H2M3S'), 3723);
  assert.equal(parseIso8601Duration('PT0S'), null);
  assert.equal(parseIso8601Duration('n/a'), null);
});

test('duration metadata is extracted from provider HTML when available', () => {
  assert.equal(parseDurationFromHtml('<meta property="og:video:duration" content="98">'), 98);
  assert.equal(parseDurationFromHtml('{"lengthSeconds":"181"}'), 181);
  assert.equal(parseDurationFromHtml('{"approxDurationMs":"90200"}'), 90);
  assert.equal(parseDurationFromHtml('<html>no duration</html>'), null);
});


test('YouTube player response duration is parsed from its player payload shapes', () => {
  assert.equal(parseDurationFromPlayerResponse({ videoDetails: { lengthSeconds: '247' } }), 247);
  assert.equal(parseDurationFromPlayerResponse({ microformat: { playerMicroformatRenderer: { lengthSeconds: '75' } } }), 75);
  assert.equal(parseDurationFromPlayerResponse({ videoDetails: { lengthSeconds: '0' } }), null);
});

test('TikTok item duration is extracted from provider page data', () => {
  assert.equal(parseDurationFromHtml('{"video":{"id":"1234567890123","height":1920,"duration":37,"ratio":"720p"}}'), 37);
  assert.equal(parseDurationFromHtml('{"duration":0}'), null);
});


test('microdata duration values are extracted even when ISO-8601 encoded', () => {
  assert.equal(parseDurationFromHtml('<meta itemprop="duration" content="PT3M45S">'), 225);
  assert.equal(parseDurationFromHtml('<meta property="og:video:duration" content="182">'), 182);
});


test('ISO-8601 parser supports multi-day archived streams and rejects invalid values', () => {
  assert.equal(parseIso8601Duration('PT25H12M3S'), 90723);
  assert.equal(parseIso8601Duration('P1DT2H3M4S'), 93784);
  assert.equal(parseIso8601Duration('PT0S'), null);
  assert.equal(parseIso8601Duration('P999DT0S'), null);
  assert.equal(isValidMediaDuration(MAX_MEDIA_DURATION_SECONDS), true);
  assert.equal(isValidMediaDuration(MAX_MEDIA_DURATION_SECONDS + 1), false);
});

test('YouTube player payload embedded in a page is parsed as structured JSON', () => {
  assert.equal(parseDurationFromHtml('<script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"181"}};</script>'), 181);
});

test('TikTok duration is found in nested rehydration JSON even when video metadata contains nested objects', () => {
  const html = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
    JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: {
      video: { id: '1234567890123456789', cover: { url: 'cover' }, nested: { codec: { name: 'h264' } }, duration: 37 }
    } } } } }) + '</script>';
  assert.equal(parseDurationFromHtml(html), 37);
});

test('TikTok inline video JSON is parsed without crossing into unrelated page metadata', () => {
  assert.equal(parseDurationFromHtml('<script>var data = {"video":{"cover":{"url":"x"},"duration":42}};</script>'), 42);
});

test('long actual durations in provider HTML are not truncated at 24 hours', () => {
  assert.equal(parseDurationFromHtml('<meta property="og:video:duration" content="PT26H">'), 93600);
});
