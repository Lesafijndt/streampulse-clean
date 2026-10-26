import test from 'node:test';import assert from 'node:assert/strict';
import {createDocumentStore} from '../server/postgres-store.js';import{bufferRequest,consumeRequest,retryDelay}from'../server/durable-intake.js';
import{metadataCachePath,lookupCachedQueueMetadata}from'../server/cached-media-metadata.js';
function store(namespace){let state={version:0,documents:{}};return createDocumentStore({namespace,readState:async()=>structuredClone(state),compareAndSwap:async(v,documents)=>{if(v!==state.version)return false;state={version:v+1,documents:structuredClone(documents)};return true}})}
test('requests save before metadata retries, then enrich without duplicate requests or chat acknowledgements',async t=>{
 const before={namespace:process.env.VITE_FIREBASE_NAMESPACE,secret:process.env.TWITCH_EVENTSUB_SECRET};process.env.VITE_FIREBASE_NAMESPACE='background-metadata';process.env.TWITCH_EVENTSUB_SECRET='test-only-background-secret';
 t.after(()=>{for(const[key,value]of[['VITE_FIREBASE_NAMESPACE',before.namespace],['TWITCH_EVENTSUB_SECRET',before.secret]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});
 const db=store('background-metadata'),url='https://youtu.be/dQw4w9WgXcQ';let payload,calls=0,replies=0;
 await bufferRequest({event:{broadcaster_user_login:'2o3a',chatter_user_login:'ordinary_viewer',message:{text:url}},messageId:'metadata-retry'}, {send:async(topic,value)=>{payload=value}});
 const dependencies={db,metadataProvider:async()=>{calls++;return{title:'Real title',durationSec:calls===1?null:213,durationProvider:'verified-provider'}},sendReply:async()=>{replies++}};
 await assert.rejects(consumeRequest(payload,dependencies),error=>error.code==='metadata_retry_pending'&&retryDelay(error).afterSeconds>=30);
 const collection=db.collection('artifacts/background-metadata/public/data/queue_videos');let rows=await collection.get();assert.equal(rows.size,1);assert.equal(rows.docs[0].data().status,'queue');
 await assert.rejects(consumeRequest(payload,dependencies),/metadata_retry_pending/);assert.equal(calls,1,'Backoff must avoid another provider request');
 await db.doc(metadataCachePath(url)).update({nextAt:0});
 assert.equal((await consumeRequest(payload,dependencies)).status,'duplicate_delivery');rows=await collection.get();assert.equal(rows.size,1);assert.equal(rows.docs[0].data().durationSec,213);
 await consumeRequest(payload,dependencies);assert.equal(calls,2);assert.equal(replies,0);
});
test('metadata cache reuses canonical media IDs across share URLs',async()=>{
 const namespace='canonical-metadata',db=store(namespace);let calls=0;const lookup=async()=>{calls++;return{durationSec:123,title:'Title'}};
 await lookupCachedQueueMetadata(db,'https://youtu.be/dQw4w9WgXcQ?si=first',{namespace,lookup,now:1000});
 const second=await lookupCachedQueueMetadata(db,'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',{namespace,lookup,now:2000});
 assert.equal(second.metadata.durationSec,123);assert.equal(calls,1);
});
