import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberCategory, learnedCategory, sanitizeClassificationMetadata} from '../src/categoryMemory.js';
import {getVideoCategory,getVideoMediaType} from '../src/mediaUtils.js';
import {buildMediaMetadataPatch} from '../src/mediaMetadata.js';
import {parsePageMetadata} from '../api/media-metadata.js';

test('category memory matches the same media and numbered series without applying to an entire creator',()=>{
 const first={url:'https://youtu.be/abcdefghijk',title:'Boys Being Boys #12'};
 const rules=rememberCategory([],first,'IRL',1);
 assert.equal(learnedCategory({...first,url:'https://youtube.com/watch?v=abcdefghijk'},rules),'IRL');
 assert.equal(getVideoCategory({url:'https://youtu.be/other',title:'Boys Being Boys #13'},rules),'IRL');
 assert.equal(learnedCategory({url:'https://youtu.be/unrelated',title:'Another video by the same creator'},rules),'');
 assert.equal(getVideoCategory({...first,category:'Memes',categoryManuallySet:true},rules),'Memes');
 const changed=rememberCategory(rules,first,'Music',2);
 assert.equal(getVideoMediaType(first,changed),'Music');assert.equal(changed.length,1);
 const generic=rememberCategory([],{url:'https://youtu.be/one',title:'TikTok Short Clip'},'IRL');
 assert.equal(learnedCategory({url:'https://youtu.be/two',title:'TikTok Short Clip'},generic),'');
});

test('content metadata adds source category, tags and creator signals while manual and learned choices win',()=>{
 const video={url:'https://youtu.be/abcdefghijk',title:'One More Day'};
 assert.equal(getVideoCategory({...video,classificationMetadata:{sourceCategory:'Music'}}),'Music');
 assert.equal(getVideoMediaType({...video,classificationMetadata:{sourceCategory:'Music'}}),'Music');
 assert.equal(getVideoCategory({...video,classificationMetadata:{authorName:'Forsen'}}),'Forsen');
 assert.equal(getVideoCategory({...video,classificationMetadata:{tags:['LeagueOfLegends']}}),'Gaming');
 assert.equal(getVideoCategory({...video,classificationMetadata:{description:'An interview with the creator. Subscribe for funny videos.'}}),'IRL');
 assert.equal(getVideoCategory({...video,title:"Limmy's Show: Dee Dee: Yoker",classificationMetadata:{sourceCategory:'Comedy'}}),'IRL');
 assert.equal(getVideoCategory({...video,category:'General',categoryManuallySet:true,classificationMetadata:{sourceCategory:'Music'}}),'General');
 const rules=rememberCategory([],video,'IRL');
 assert.equal(getVideoCategory({...video,classificationMetadata:{authorName:'Forsen'}},rules),'IRL');
});

test('source signals are bounded and late metadata cannot change the replacement request',()=>{
 const value=sanitizeClassificationMetadata({description:'x'.repeat(5000),tags:Array(50).fill('z'.repeat(100)),authorName:'a'.repeat(300),secret:'not copied'});
 assert.equal(value.description.length,1200);assert.equal(value.tags.length,20);assert.equal(value.tags[0].length,60);assert.equal(value.authorName.length,100);assert.equal(value.secret,undefined);
 const video={id:'one',timestamp:1,url:'https://youtu.be/abcdefghijk',title:'An original title'};
 assert.deepEqual(buildMediaMetadataPatch(video,{...video,timestamp:2},{classificationMetadata:value}),{});
 const patch=buildMediaMetadataPatch(video,video,{classificationMetadata:value,status:'watched'});
 assert.deepEqual(Object.keys(patch),['classificationMetadata']);
});

test('YouTube source hints come from the requested player payload, never recommendations',()=>{
 const payload={videoDetails:{videoId:'abcdefghijk',author:'Artist - Topic',channelId:'UC123',shortDescription:'A song',keywords:['music']},microformat:{playerMicroformatRenderer:{category:'Music'}}};
 const html='var ytInitialPlayerResponse = '+JSON.stringify(payload)+';';
 const data=parsePageMetadata(html,'abcdefghijk');
 assert.equal(data.classificationMetadata.sourceCategory,'Music');assert.equal(data.classificationMetadata.authorName,'Artist - Topic');
 assert.equal(parsePageMetadata(html,'different').classificationMetadata,undefined);
});
