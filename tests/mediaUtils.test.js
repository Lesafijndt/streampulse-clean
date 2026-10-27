import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectVideoCategory,
  dedupeMediaVideos,
  getMediaIdentityKey,
  getStableMediaDocumentId,
  getVideoCategory,
  getVideoMediaType,
  parseMediaUrl
} from '../src/mediaUtils.js';

test('YouTube URL variants resolve to the same canonical media identity', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(parseMediaUrl('https://www.youtube.com/watch?v=' + id).videoId, id);
  assert.equal(parseMediaUrl('https://youtu.be/' + id).videoId, id);
  assert.equal(getMediaIdentityKey('youtube', id, 'https://youtu.be/' + id), 'youtube:' + id.toLowerCase());
});

test('TikTok full video URLs expose the numeric video ID needed by the embed', () => {
  const parsed = parseMediaUrl('https://www.tiktok.com/@creator/video/1234567890123456789');
  assert.equal(parsed.platform, 'tiktok');
  assert.equal(parsed.videoId, '1234567890123456789');
});

test('stable media document IDs are deterministic for a given identity', () => {
  const identity = 'youtube:dQw4w9WgXcQ';
  assert.equal(getStableMediaDocumentId(identity), getStableMediaDocumentId(identity));
  assert.match(getStableMediaDocumentId(identity), /^media-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
});

test('history cannot hide or delete a new request for the same media', () => {
  const input = [
    { id: 'queued-copy', url: 'https://youtu.be/dQw4w9WgXcQ', platform: 'youtube', videoId: 'dQw4w9WgXcQ', status: 'queue', timestamp: 1 },
    { id: 'played-copy', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', platform: 'youtube', videoId: 'dQw4w9WgXcQ', status: 'watched', timestamp: 2 }
  ];
  const result = dedupeMediaVideos(input);
  assert.deepEqual(result.videos.map((video) => video.id), ['queued-copy', 'played-copy']);
  assert.deepEqual(result.duplicateIds, []);
});

test('manual category is authoritative and auto music detection remains consistent', () => {
  assert.equal(getVideoMediaType({ url: 'https://www.tiktok.com/@c/video/1234567890123', category: 'General', categoryManuallySet: true }), 'Non-Music');
  assert.equal(getVideoMediaType({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Unknown title' }), 'Music');
  assert.equal(getVideoCategory({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Unknown title', category: 'General' }), 'Music');
});

test('Twitch Clips requires a real Twitch clip URL, never a generic short clip title', () => {
 const tik='https://www.tiktok.com/@clip/video/1234567890123';
 assert.equal(detectVideoCategory(tik,'TikTok Short Clip'),'General');
 assert.equal(getVideoCategory({url:tik,title:'Yes King Creature And Winter',category:'Clips'}),'Memes');
 assert.equal(getVideoCategory({url:tik,title:'TikTok Short Clip',category:'Clips',categoryManuallySet:true}),'General');
 assert.equal(detectVideoCategory('https://youtu.be/abcdefghijk','Twitch clip reaction'),'IRL');
 assert.equal(detectVideoCategory('https://clips.twitch.tv/ExampleSlug','A moment'),'Clips');
 assert.equal(detectVideoCategory('https://www.twitch.tv/2o3a/clip/ExampleSlug','A moment'),'Clips');
 assert.equal(detectVideoCategory('https://example.com/clip/ExampleSlug','A moment'),'General');
 assert.equal(detectVideoCategory('https://clips.twitch.tv.attacker.example/Fake','A moment'),'General');
});
test('memes use content words, reclassify enriched automatic titles, and preserve manual choices', () => {
 const url='https://youtu.be/abcdefghijk';
 for(const title of ['Funny cat compilation','MEMES compilation','brainrot remix','Yes King Creature And Winter','A cursed gaming montage']) assert.equal(detectVideoCategory(url,title),'Memes',title);
 assert.equal(getVideoCategory({url,title:'Meme remix',category:'Music'}),'Memes');
 assert.equal(getVideoCategory({url,title:'Meme remix',category:'Music',categoryManuallySet:true}),'Music');
 assert.equal(getVideoCategory({url,title:'Meme compilation',category:'General'}),'Memes');
 assert.equal(detectVideoCategory('https://youtu.be/shitpost123','A landscape'),'General');
 assert.equal(detectVideoCategory('https://www.tiktok.com/@meme/video/1234567890123','A landscape'),'General');
 assert.equal(detectVideoCategory(url,'A telescope in space'),'General');
 assert.equal(detectVideoCategory(url,'Album official audio'),'Music');
});

test('streamer category examples follow content preferences rather than generic comedy or dash formatting', () => {
 const url='https://youtu.be/abcdefghijk';
 const cases=[
 ['Boys Being Boys #12','Memes'],
 ['xQc Gets Trolled By Car Chase Streamer','Memes'],
 ['Man With The Biggest Dick In The World','Memes'],
 ['Guy Smells Bloody Fingers In Walmart!','IRL'],
 ["Limmy's Show: Dee Dee: Yoker",'IRL'],
 ["Limmy's Show: A funny sketch",'IRL'],
 ["Limmy's Favourite Prank Call",'Memes'],
 ["malfoid - Malfoy & Potter's First Date EP07",'General'],
 ['EVO 2011 - Best Commentating Ever w/ Kayo Police','Gaming'],
 ['EVO 2026 tournament finals','Gaming'],
 ['I Bought 2 Broken Nintendo Switches for $80 Each - Can I Fix Them?','IRL'],
 ['average forsen throw experience #LeagueOfLegends #highlight #Shorts','Forsen'],
 ['Pink Floyd - Time (No Intro/No Clocks)','Music'],
 ['Pink Floyd \u2013 Time','Music'],
 ['Unknown Creator - An unknown title','General'],
 ['Artist - Official Audio','Music'],
 ['Minecraft OST - Official Audio','Music'],
 ['Creator reacts to an official music video','IRL'],
 ['Repair review - soundtrack','IRL'],
 ["Here's to you feat Billy Herrington Right Version",'Memes'],
 ['An ace reporter spots a single telescope','General'],
 ['#\u043c\u0435\u043c\u044b','Memes'],['#\u0433\u0435\u0439\u043c\u043f\u043b\u0435\u0439','Gaming']
 ];
 for(const [title,expected] of cases){
  assert.equal(getVideoCategory({url,title,category:'Music'}),expected,title);
  assert.equal(getVideoCategory({url,title,category:'General',categoryManuallySet:true}),'General','manual: '+title);
 }
});

test('URLs and creator handles do not classify content, compound hashtags and Unicode tags do', () => {
 const url='https://youtu.be/abcdefghijk';
 assert.equal(detectVideoCategory(url,'A landscape @funny'),'General');
 assert.equal(detectVideoCategory(url,'#League_of_Legends'),'Gaming');
 assert.equal(detectVideoCategory(url,'#leagueoflegendsfan'),'General');
 assert.equal(detectVideoCategory('https://clips.twitch.tv/RealClip','#music #memes'),'Clips');
 assert.equal(getVideoMediaType({url,title:'EVO 2011 - Best Commentating Ever'}),'Non-Music');
 assert.equal(getVideoMediaType({url,title:'Artist - Official Audio'}),'Music');
 assert.equal(getVideoMediaType({url,title:'Reacting to official audio'}),'Non-Music');
 assert.equal(getVideoMediaType({url,title:'Gachi remix Right Version'}),'Music');
});

test('Forsen has priority across platforms, aliases and content genres without substring or URL-ID guesses', () => {
 const url='https://youtu.be/abcdefghijk';
 for(const title of ['Forsen reacts to a meme','Forsen Minecraft gameplay','Forsen - Official Audio',"Forsen's funniest moments",'#ForsenClips','@forsen dancing','Hans Eli Sebastian Fors interview','Sebastian Fors','forsenSpectate compilation'])assert.equal(getVideoCategory({url,title,category:'Music'}),'Forsen',title);
 assert.equal(detectVideoCategory('https://www.twitch.tv/forsen/clip/SomeSlug','A clip'),'Forsen');
 assert.equal(detectVideoCategory('https://clips.twitch.tv/SomeSlug','Forsen playing'),'Forsen');
 assert.equal(detectVideoCategory('https://www.tiktok.com/@creator/video/1234567890123','#forsen funny'),'Forsen');
 assert.equal(detectVideoCategory('https://youtu.be/forsen12345','A landscape'),'General');
 assert.equal(detectVideoCategory(url,'Forsaken gameplay'),'Gaming');
 assert.equal(detectVideoCategory('https://twitch.tv.attacker.example/forsen/clip/a','A landscape'),'General');
 assert.equal(getVideoCategory({url,title:'Forsen reacts',category:'IRL',categoryManuallySet:true}),'IRL');
});
