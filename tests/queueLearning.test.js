import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentStore} from '../server/postgres-store.js';
import {handlePrivateStore} from '../server/private-store-api.js';
import {persistChatEvent} from '../server/webhook-queue.js';
import {getPlaybackGeneration} from '../src/playerBridge.js';
const namespace='streampulse-live-deck',prefix=`artifacts/${namespace}/public/data/`;
function setup(){
 const video={id:'one',channelRoom:'2o3a',url:'https://youtu.be/abcdefghijk?code=do-not-copy',title:'Boys Being Boys #12',timestamp:1,playedAt:2,status:'playing',platform:'youtube',queueOrder:3,upvotes:7};
 let state={version:0,documents:{[prefix+'queue_videos/one']:video,[prefix+'room_settings/2o3a']:{streamSettings:{queueOpen:true}}}};
 const db=createDocumentStore({namespace,readState:async()=>structuredClone(state),compareAndSwap:async(version,next)=>{if(version!==state.version)return false;state={version:version+1,documents:structuredClone(next)};return true;}});
 const call=async(body,login='paim_beach_pete',view)=>{
  const res={status(n){this.code=n;return this},json(value){this.body=value;return this}};
  await handlePrivateStore({method:body?'POST':'GET',body,query:{view},headers:{origin:'https://203a.vercel.app',host:'203a.vercel.app'}},res,{login},{db,namespace});return res;
 };
 return {db,video,call,state:()=>state};
}
test('learning is atomic, staff-only, generation-checked and retains playing state and queue controls',async()=>{
 const {video,call,state}=setup();const body={operation:'learn-category',id:'one',generation:getPlaybackGeneration(video),category:'IRL'};
 assert.equal((await call(body,'ordinary_viewer')).code,403);
 assert.equal((await call({...body,generation:'stale'})).code,409);
 assert.equal((await call({...body,category:'Unknown'})).code,400);
 assert.equal((await call({...body,category:'__proto__'})).code,400);
 assert.equal((await call(body,'2o3a')).body.ok,true);
 const row=state().documents[prefix+'queue_videos/one'];
 for(const key of ['status','queueOrder','timestamp','playedAt','upvotes'])assert.equal(row[key],video[key]);
 assert.equal(row.categoryManuallySet,true);assert.equal(row.category,'IRL');
 const settings=state().documents[prefix+'room_settings/2o3a'];assert.equal(settings.categoryCorrections.length,1);assert.equal(settings.streamSettings.queueOpen,true);
 await Promise.all([call({...body,category:'Memes'}),call({...body,category:'Music'})]);
 assert.equal(state().documents[prefix+'room_settings/2o3a'].categoryCorrections.length,1);
});

test('reports enforce paim ownership, omit secrets, rate-limit duplicates and never update queue rows',async()=>{
 const {video,call,state}=setup();const body={operation:'report-playback',id:'one',generation:getPlaybackGeneration(video),issue:'black_screen',providerCode:'100',seconds:42,volume:50,muted:true,paused:true,token:'secret',url:'https://bad.example/?token=secret'};
 for(const login of ['2o3a','viewer']){
  assert.equal((await call(body,login)).code,403);
  assert.equal((await call(null,login,'playback-reports')).code,403);
 }
 assert.equal((await call({...body,generation:'stale'})).code,409);
 const saved=await call(body);assert.equal(saved.body.ok,true);assert.equal(saved.body.report.seconds,42);assert.equal(saved.body.report.volume,50);assert.equal(saved.body.report.providerCode,'100');
 assert.equal(JSON.stringify(saved.body).includes('secret'),false);assert.equal(JSON.stringify(saved.body).includes('code='),false);
 assert.deepEqual(state().documents[prefix+'queue_videos/one'],video);
 assert.equal((await call(body)).code,409);
 assert.equal((await call(null,'paim_beach_pete','playback-reports')).body.reports.length,1);
});

test('future Twitch intake uses remembered episode corrections without a browser or acknowledgements', async()=>{
 const {db,video,call}=setup();
 await call({operation:'learn-category',id:'one',generation:getPlaybackGeneration(video),category:'IRL'},'2o3a');
 const result=await persistChatEvent(db,{messageId:'learned-future',subscriptionId:'test',event:{broadcaster_user_login:'2o3a',chatter_user_login:'ordinary_viewer',message:{text:'https://youtu.be/abcdefghij2'}}},{lookupMetadata:async()=>({title:'Boys Being Boys #13',classificationMetadata:{version:1,sourceCategory:'Comedy'}})});
 assert.equal(result.queued,1);
 const state=await db.readState();const rows=Object.values(state.documents).filter(row=>row.url==='https://youtu.be/abcdefghij2');
 assert.equal(rows.length,1);assert.equal(rows[0].category,'IRL');assert.equal(rows[0].status,'queue');assert.equal(rows[0].categoryManuallySet,false);
});
