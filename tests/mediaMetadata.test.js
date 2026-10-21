import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationFromHtml, parseDurationFromPlayerResponse, parseIso8601Duration } from '../api/media-metadata.js';

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
