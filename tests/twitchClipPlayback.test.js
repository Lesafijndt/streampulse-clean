import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClipPlayback, normalizePublicClip, getClipPlayback } from '../server/twitch-clip-playback.js';
test('clip segment validates a retained VOD and preserves fractional timing', () => {
  assert.deepEqual(normalizeClipPlayback({ video_id: '123', vod_offset: 0, duration: 12.5 }),
    { available: true, videoId: '123', offsetSeconds: 0, durationSeconds: 12.5 });
  for (const clip of [{ video_id: '', vod_offset: null, duration: 20 }, { video_id: '123', vod_offset: null, duration: 20 },
    { video_id: '123', vod_offset: 10, duration: 0 }]) assert.equal(normalizeClipPlayback(clip).available, false);
});
test('playback lookup uses fixed Twitch hosts, hides tokens and checks source existence', async () => {
  const before = { id: process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET };
  process.env.TWITCH_CLIENT_ID = 'test-clip-id'; process.env.TWITCH_CLIENT_SECRET = 'test-secret';
  try {
    const urls = [];
    const request = async url => {
      urls.push(url);
      if (url.includes('oauth2/token')) return Response.json({ access_token: 'private', expires_in: 3600 });
      if (url.includes('/clips?')) return Response.json({ data: [{ video_id: '123', vod_offset: 10, duration: 20 }] });
      return Response.json({ data: [{ id: '123' }] });
    };
    const value = await getClipPlayback(new URL('https://clips.twitch.tv/ExampleSlug'), request);
    assert.equal(value.available, true); assert.equal(JSON.stringify(value).includes('private'), false);
    assert.equal(urls.length, 4);
    assert.equal((await getClipPlayback(new URL('https://evil.test/clip/slug'), request)).available, false);
    assert.equal(urls.length, 4);
  } finally {
    for (const [key, value] of [['TWITCH_CLIENT_ID', before.id], ['TWITCH_CLIENT_SECRET', before.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('public clip MP4 remains playable without an original broadcast or dashboard OAuth', async () => {
  const clip = { isPublished: true, durationSeconds: 60, playbackAccessToken: { signature: 'public-signature', value: 'public-playback-grant' },
    assets: [{ videoQualities: [{ quality: '720', sourceURL: 'https://production.assets.clips.twitchcdn.net/public-clip.mp4' }] }] };
  const result = await getClipPlayback(new URL('https://clips.twitch.tv/PublicSlug'), async url => {
    assert.equal(url, 'https://gql.twitch.tv/gql');
    return Response.json([{ data: { clip } }]);
  });
  assert.equal(result.mode, 'direct');
  assert.equal(result.durationSeconds, 60);
  assert.equal(new URL(result.mediaUrl).searchParams.get('sig'), 'public-signature');
  assert.equal(normalizePublicClip({ ...clip, isPublished: false }), null);
  assert.equal(normalizePublicClip({ ...clip, assets: [{ videoQualities: [{ sourceURL: 'https://evil.test/clip.mp4' }] }] }), null);
});
