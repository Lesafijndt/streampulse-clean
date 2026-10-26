import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { parseServerCommand, persistChatCommand } from '../server/chat-commands.js';
import { bufferRequest, consumeRequest } from '../server/durable-intake.js';
import { sendCommandReply, chunkCommandReply } from '../server/command-reply.js';
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
    assert.ok(payload);await consumeRequest(payload,{db,sendReply,lookupMetadata:null});
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


test('!when includes every full title across playing, waiting and watch later in bounded chunks', async () => {
  const db=store(),replies=[];
  const rows=[video('now','ordinary_viewer','playing'),...Array.from({length:18},(_,i)=>({...video('waiting-'+i,'ordinary_viewer','queue',i+1),title:'Full waiting title '+i+' '+ '\u{1F600}'.repeat(45)})),
    {...video('later','ordinary_viewer','watch_later'),title:'Complete watch later title'}, video('other','other'), video('history','ordinary_viewer','watched')];
  for(const row of rows)await db.doc(prefix+'queue_videos/'+row.id).set(row);
  const result=await persistChatCommand(db,{event:event('!when'),messageId:'all-positions'},{sendReply:async message=>{replies.push(message);return{sent:true}}});
  assert.ok(replies.length>3);assert.ok(replies.every(reply=>Array.from(reply).length<=450&&reply.startsWith('@ordinary_viewer ')));
  const content=replies.map(reply=>reply.slice('@ordinary_viewer '.length)).join('');
  for(const row of rows.filter(row=>row.requestedBy==='ordinary_viewer'&&row.status!=='watched'))assert.ok(content.includes(row.title),row.id);
  assert.ok(content.includes('Playing now:'));assert.ok(content.includes('Watch later:'));assert.ok(!content.includes('history'));
  assert.equal(result.replyDelivery,'sent');
});
test('completed chunks survive transport interruption and resume after command freshness expires',async()=>{
  const db=store();for(let i=0;i<14;i++)await db.doc(prefix+'queue_videos/v'+i).set({...video('v'+i,'ordinary_viewer'),title:'Unique '+i+' '+ 'x'.repeat(100)});
  const payload={event:event('!when'),messageId:'resume-chunks'},sent=[];let fail=true;
  const sendReply=async message=>{if(sent.length===1&&fail)throw Error('Temporary transport failure');sent.push(message);return{sent:true}};
  await assert.rejects(persistChatCommand(db,payload,{sendReply}),/Temporary/);assert.equal(sent.length,1);
  fail=false;const result=await persistChatCommand(db,{...payload,expiresAt:Date.now()-1000},{sendReply});
  assert.equal(result.replyDelivery,'sent');assert.equal(sent.filter(chunk=>chunk===sent[0]).length,1);
  assert.equal(sent.length,result.replyChunks.length);
  const expired=await persistChatCommand(db,{event:event('!remove'),messageId:'never-created',expiresAt:Date.now()-1000},{sendReply});assert.equal(expired.status,'command_expired');
});
test('fallback chunks fill capacity without evicting earlier chunks and resume from durable progress',async()=>{
  const db=store();for(let i=0;i<10;i++)await db.doc(prefix+'queue_videos/v'+i).set({...video('v'+i,'ordinary_viewer'),title:'Title '+i+' '+ 'x'.repeat(100)});
  const room=db.doc(prefix+'room_settings/2o3a');await room.set({channelRoom:'2o3a',chatCommandFeed:Array.from({length:29},(_,i)=>({id:'existing-'+i,at:Date.now(),reply:'Earlier reply'}))});
  const payload={event:event('!when'),messageId:'fallback-chunks'},sendReply=async()=>({sent:false,code:'grant_missing'});
  await assert.rejects(persistChatCommand(db,payload,{sendReply}),/feed_full/);
  const first=(await room.get()).data();assert.equal(first.chatCommandFeed.length,30);const delivered=first.chatCommandFeed.at(-1);
  await room.set({...first,chatCommandFeed:[delivered]});
  const result=await persistChatCommand(db,payload,{sendReply});assert.equal(result.replyDelivery,'dashboard');
  const feed=(await room.get()).get('chatCommandFeed');assert.equal(feed.length,result.replyChunks.length);assert.equal(new Set(feed.map(chunk=>chunk.id)).size,feed.length);
});
test('!queue points viewers to the public queue',async()=>{
  const replies=[];await persistChatCommand(store(),{event:event('!queue'),messageId:'queue-link'},{sendReply:async message=>{replies.push(message);return{sent:true}}});
  assert.ok(replies[0].includes('https://streampulse-clean.vercel.app/queue'));
});
test('reply splitting preserves Unicode content and sender rejects oversize instead of truncating',async()=>{
  const text='\u{1F600}'.repeat(1100);const chunks=chunkCommandReply('@viewer '+text,'@viewer ');
  assert.equal(chunks.map(chunk=>chunk.slice(8)).join(''),text);assert.ok(chunks.every(chunk=>Array.from(chunk).length<=450));
  let requests=0;assert.deepEqual(await sendCommandReply(text,async()=>{requests++;throw Error('Unexpected network')}),{sent:false,code:'chat_reply_invalid_length'});assert.equal(requests,0);
});

test('large replies deliver bounded batches and retry only the remaining chunks',async()=>{
  const db=store();for(let i=0;i<18;i++)await db.doc(prefix+'queue_videos/b'+i).set({...video('b'+i,'ordinary_viewer'),title:'Full title '+i+' '+ 'z'.repeat(430)});
  const payload={event:event('!when'),messageId:'bounded-batch'},sent=[];
  const sendReply=async message=>{sent.push(message);return{sent:true}};
  await assert.rejects(persistChatCommand(db,payload,{sendReply}),/chat_reply_pending/);assert.equal(sent.length,8);
  let result;for(let i=0;i<10;i++){try{result=await persistChatCommand(db,{...payload,expiresAt:0},{sendReply});break;}catch(error){assert.match(error.message,/chat_reply_pending/);}}
  assert.equal(result.replyDelivery,'sent');assert.equal(sent.length,result.replyChunks.length);assert.equal(sent.filter(chunk=>chunk===sent[0]).length,1);
});
test('volume commands do not evict live fallback reply chunks from a full feed',async()=>{
  const db=store(),room=db.doc(prefix+'room_settings/2o3a');const feed=Array.from({length:30},(_,i)=>({id:'reply-'+i,at:Date.now(),reply:'Keep reply '+i}));await room.set({chatCommandFeed:feed});
  const payload={event:event('!volume 50','2o3a'),messageId:'full-volume'};
  await assert.rejects(persistChatCommand(db,payload),/chat_command_feed_full/);assert.deepEqual((await room.get()).get('chatCommandFeed'),feed);
  await room.set({chatCommandFeed:feed.slice(1)});await persistChatCommand(db,payload);assert.equal((await room.get()).get('chatCommandFeed').at(-1).volumeCommand.value,50);
});
