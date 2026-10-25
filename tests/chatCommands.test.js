import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { parseServerCommand, persistChatCommand } from '../server/chat-commands.js';
import { bufferRequest, consumeRequest } from '../server/durable-intake.js';
import { sendCommandReply } from '../server/command-reply.js';
const namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck';
const prefix = `artifacts/${namespace}/public/data/`;
function store() { let state={version:0,documents:{}};return createDocumentStore({namespace,
  readState:async()=>structuredClone(state),compareAndSwap:async(v,documents)=>{if(v!==state.version)return false;state={version:v+1,documents:structuredClone(documents)};return true}}); }
const event=(text,login='ordinary_viewer',badges=[])=>({broadcaster_user_login:'2o3a',chatter_user_login:login,badges:badges.map(set_id=>({set_id})),message:{text}});
const video=(id,by,status='queue',queueOrder=1)=>({id,channelRoom:'2o3a',status,requestedBy:by,title:id,timestamp:queueOrder,queueOrder,url:'https://youtu.be/dQw4w9WgXcQ',voters:[],upvotes:0});
test('command parsing excludes requests/bots and derives staff authority from signed event badges',()=>{
  for(const text of ['https://youtu.be/dQw4w9WgXcQ','!assr https://youtu.be/dQw4w9WgXcQ','hello'])assert.equal(parseServerCommand(event(text)),null);
  assert.equal(parseServerCommand(event('!help','gachibot69')),null);
  assert.equal(parseServerCommand(event('!skip')).permitted,false);
  assert.equal(parseServerCommand(event('!skip','random_mod',['moderator'])).permitted,true);
  assert.equal(parseServerCommand(event('!volume 50','2o3a')).volumeCommand.value,50);
});
test('server commands vote/reorder, remove only own waiting request and skip idempotently without a dashboard',async()=>{
  const db=store(),replies=[];const sendReply=async message=>{replies.push(message);return{sent:true}};
  for(const v of [video('playing','owner','playing'),video('first','other','queue',1),video('own','ordinary_viewer','queue',2)])await db.doc(prefix+'queue_videos/'+v.id).set(v);
  const run=(text,messageId,login='ordinary_viewer',badges=[])=>persistChatCommand(db,{event:event(text,login,badges),messageId},{sendReply});
  await run('!vote 1','vote');assert.equal((await db.doc(prefix+'queue_videos/first').get()).get('upvotes'),1);
  await run('!vote 1','vote');assert.equal((await db.doc(prefix+'queue_videos/first').get()).get('upvotes'),1);assert.equal(replies.length,1);
  await run('!remove','remove');assert.equal((await db.doc(prefix+'queue_videos/own').get()).exists,false);
  await run('!skip','viewer-skip');assert.equal((await db.doc(prefix+'queue_videos/playing').get()).get('status'),'playing');
  await run('!skip','mod-skip','random_mod',['moderator']);await run('!skip','mod-skip','random_mod',['moderator']);
  assert.equal((await db.doc(prefix+'queue_videos/first').get()).get('status'),'playing');
  assert.equal((await db.doc(prefix+'queue_videos/playing').get()).get('status'),'watched');
  assert.equal((await db.collection(prefix+'queue_events').get()).size,4);
});
test('command replies fall back once, and only authorized volume commands enter the dashboard feed',async()=>{
  const db=store();let sends=0;const sendReply=async()=>{sends++;return{sent:false,code:'bot_chat_grant_required'}};
  const run=(text,id,login='ordinary_viewer')=>persistChatCommand(db,{event:event(text,login),messageId:id},{sendReply});
  await run('!queue','summary');await run('!queue','summary');
  await run('!volume 50','viewer-volume');await run('!volume 50','streamer-volume','2o3a');
  const settings=(await db.doc(prefix+'room_settings/2o3a').get()).data();
  assert.equal(sends,1);assert.equal(settings.chatCommandFeed.length,2);
  assert.equal(settings.chatCommandFeed.filter(packet=>packet.volumeCommand).length,1);
  assert.equal(settings.chatCommandFeed.find(packet=>packet.volumeCommand).volumeCommand.value,50);
});
test('durable intake carries chat commands but video requests never send acknowledgments or alerts',async t=>{
  const old=process.env.TWITCH_EVENTSUB_SECRET;process.env.TWITCH_EVENTSUB_SECRET='command-test-secret-0123456789';
  t.after(()=>{if(old===undefined)delete process.env.TWITCH_EVENTSUB_SECRET;else process.env.TWITCH_EVENTSUB_SECRET=old});
  const db=store();let replies=0;const sendReply=async()=>{replies++;return{sent:true}};
  for(const [index,text] of ['!help','https://youtu.be/dQw4w9WgXcQ','!assr https://youtu.be/dQw4w9WgXcQ'].entries()){
    let payload;await bufferRequest({event:event(text),messageId:'delivery-'+index,subscriptionId:'sub'},{send:async(_topic,body)=>{payload=body}});
    assert.ok(payload);await consumeRequest(payload,{db,sendReply});
  }
  assert.equal(replies,1);assert.equal((await db.collection(prefix+'queue_videos').get()).size,1);
});
test('app-token replies target only the configured bot and broadcaster and report missing grants safely',async t=>{
  const oldId=process.env.TWITCH_CLIENT_ID,oldSecret=process.env.TWITCH_CLIENT_SECRET;
  process.env.TWITCH_CLIENT_ID='test-app';process.env.TWITCH_CLIENT_SECRET='test-secret';
  t.after(()=>{for(const[key,value]of[['TWITCH_CLIENT_ID',oldId],['TWITCH_CLIENT_SECRET',oldSecret]])if(value===undefined)delete process.env[key];else process.env[key]=value});
  let sent;
  const request=async(url,options)=>{
    if(url.includes('/oauth2/token'))return Response.json({access_token:'private',expires_in:3600});
    if(url.includes('/users?'))return Response.json({data:[{login:'2o3a',id:'room'},{login:'gachibot69',id:'bot'}]});
    sent=JSON.parse(options.body);return Response.json({message:'missing grant'},{status:403});
  };
  assert.deepEqual(await sendCommandReply('Command response',request),{sent:false,code:'bot_chat_grant_required'});
  assert.equal(sent.broadcaster_id,'room');assert.equal(sent.sender_id,'bot');assert.equal(sent.for_source_only,true);
});
