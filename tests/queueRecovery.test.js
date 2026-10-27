import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentStore } from '../server/postgres-store.js';
import { handlePrivateStore } from '../server/private-store-api.js';
const namespace='recovery-tests', prefix=`artifacts/${namespace}/public/data/`;
const row=(id,extra={})=>({id,channelRoom:'2o3a',status:'queue',timestamp:1,queueOrder:1000,url:'https://youtu.be/dQw4w9WgXcQ',title:id,...extra});
function setup(){let state={version:0,documents:{[prefix+'queue_videos/a']:row('a'),[prefix+'queue_videos/b']:row('b',{queueOrder:2000}),[prefix+'queue_videos/live']:row('live',{status:'playing'})}};
 const db=createDocumentStore({namespace,readState:async()=>structuredClone(state),compareAndSwap:async(v,documents)=>{if(v!==state.version)return false;state={version:v+1,documents:structuredClone(documents)};return true}});
 const api=async(body,login='paim_beach_pete',view)=>{const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
 await handlePrivateStore({method:body?'POST':'GET',query:{view},headers:{host:'streampulse-clean.vercel.app',origin:'https://streampulse-clean.vercel.app'},body},res,{login},{db,namespace,random:()=>0});return res};return{db,api,state:()=>state};}
test('selective undo preserves playback, new requests and later metadata; streamer can use recovery while viewers cannot',async()=>{
 const {db,api,state}=setup();const live=structuredClone(state().documents[prefix+'queue_videos/live']);
 assert.equal((await api({operation:'shuffle',expectedVersion:0},'2o3a')).code,200);
 const snapshot=(await api(null,'paim_beach_pete','recovery')).body.snapshots[0];
 assert.equal((await api(null,'2o3a','recovery')).code,200);
 assert.equal((await api(null,'ordinary_viewer','recovery')).code,403);
 assert.equal((await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'},'ordinary_viewer')).code,403);
 await db.doc(prefix+'queue_videos/a').update({title:'Updated title',durationSec:42,upvotes:7});await db.doc(prefix+'queue_videos/new').set(row('new',{timestamp:2,queueOrder:9999}));
 const result=await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'},'2o3a');assert.equal(result.body.restored,2);
 assert.equal(state().documents[prefix+'queue_videos/a'].title,'Updated title');assert.equal(state().documents[prefix+'queue_videos/a'].upvotes,7);
 assert.equal(state().documents[prefix+'queue_videos/a'].queueOrder,1000);assert.ok(state().documents[prefix+'queue_videos/new']);
 assert.deepEqual(state().documents[prefix+'queue_videos/live'],live);
 assert.equal((await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'})).body.restored,0);
});
test('reset snapshots restore missing requests without clearing arrivals and retain only twelve snapshots',async()=>{
 const {db,api,state}=setup();
 for(let i=0;i<15;i++)assert.equal((await api({operation:'shuffle',expectedVersion:state().version})).code,200);
 assert.equal((await api(null,'paim_beach_pete','recovery')).body.snapshots.length,12);
 assert.equal((await api({operation:'reset',scope:'queue',confirmation:'RESET',expectedVersion:state().version})).code,200);
 const snapshot=(await api(null,'paim_beach_pete','recovery')).body.snapshots.find(snapshot=>snapshot.action==='Reset queue');
 await db.doc(prefix+'queue_videos/new').set(row('new'));
 assert.equal((await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'})).body.restored,2);
 assert.ok(state().documents[prefix+'queue_videos/new']);assert.equal(state().documents[prefix+'queue_videos/live'].status,'playing');
});
test('undo skips a request that has started playing since the saved action',async()=>{
 const {db,api,state}=setup();await api({operation:'shuffle',expectedVersion:0});
 const snapshot=(await api(null,'paim_beach_pete','recovery')).body.snapshots[0];
 await db.doc(prefix+'queue_videos/a').update({status:'playing',playedAt:123});
 const result=await api({operation:'undo-snapshot',id:snapshot.id,confirmation:'RESTORE'});
 assert.equal(result.body.skipped,1);assert.equal(state().documents[prefix+'queue_videos/a'].status,'playing');
});
