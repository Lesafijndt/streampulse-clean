import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentStore} from '../server/postgres-store.js';
import {persistChatCommand,parseServerCommand} from '../server/chat-commands.js';
import {createPointsClient} from '../server/streamelements-points.js';
import {promotionLabel} from '../src/promotion.js';
import {projectPublicQueue} from '../server/public-queue.js';
import {handlePrivateStore} from '../server/private-store-api.js';
import {selectNextVideoCandidate} from '../src/queueLogic.js';
import {bufferRequest,consumeRequest} from '../server/durable-intake.js';

const namespace=process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck',prefix=`artifacts/${namespace}/public/data/`;
function setup({count=10,balance=1000,adjust,cas}={}) {
  let state={version:0,documents:{}};
  const db=createDocumentStore({namespace,readState:async()=>structuredClone(state),compareAndSwap:async(version,documents)=>{
    if(cas?.())return false;
    if(version!==state.version)return false;state={version:version+1,documents:structuredClone(documents)};return true;
  }});
  for(let i=0;i<=count;i++)state.documents[prefix+'queue_videos/v'+i]={id:'v'+i,channelRoom:'2o3a',status:i===0?'playing':'queue',requestedBy:i===count?'viewer':'other',title:'Video '+i,url:'https://youtu.be/test'+i,timestamp:i+100,queueOrder:i*1000};
  const playing=structuredClone(state.documents[prefix+'queue_videos/v0']);
  const calls=[],replies=[];
  const points={balance:async()=>balance,adjust:async(login,amount)=>{calls.push({login,amount});if(adjust)await adjust(login,amount);balance+=amount;}};
  const run=(text,id,login='viewer')=>persistChatCommand(db,{event:{broadcaster_user_login:'2o3a',chatter_user_login:login,message:{text}},messageId:id},{points,sendReply:async text=>{replies.push(text);return{sent:true}}});
  const row=id=>state.documents[prefix+'queue_videos/'+id];
  const queue=()=>Object.values(state.documents).filter(row=>row.status==='queue').sort((a,b)=>a.queueOrder-b.queueOrder).map(row=>row.id);
  return{db,run,calls,replies,row,queue,playing,state:()=>state,balance:()=>balance};
}
test('promotion from #10 costs 450, becomes next up, is visible everywhere, and duplicate deliveries never charge twice',async()=>{
  let conflicts=0;const f=setup({cas:()=>++conflicts===2});
  const result=await f.run('!promote 10 450','buy');await f.run('!promote 10 450','buy');
  assert.equal(result.command,'promote');assert.equal(f.calls.length,1);assert.equal(f.calls[0].amount,-450);
  assert.equal(f.balance(),550);assert.equal(f.queue()[0],'v10');assert.equal(f.queue().length,10);assert.deepEqual(f.row('v0'),f.playing);
  assert.equal(selectNextVideoCandidate(Object.values(f.state().documents).filter(row=>row.id?.startsWith('v')), {...f.playing,nextTrackOverrideId:'v1'}, (a,b)=>a.queueOrder-b.queueOrder).id,'v10');
  assert.match(promotionLabel(f.row('v10')),/Promoted.*450 points spent/);
  const view=projectPublicQueue(f.state().documents,namespace);assert.match(view.queue[0].promotionLabel,/450 points spent/);
  await f.run('!when','when');assert.match(f.replies.at(-1),/450 points spent/);
  await f.run('!queue','queue');assert.match(f.replies.at(-1),/450 points spent/);
  await f.run('!promote','again');assert.equal(f.calls.length,1);
});
test('cancellation restores original order and refunds exactly once, retaining playback and new arrivals',async()=>{
  const f=setup();await f.run('!promote 10 450','buy');
  await f.db.doc(prefix+'queue_videos/new').set({id:'new',status:'queue',channelRoom:'2o3a',requestedBy:'other',queueOrder:50000,timestamp:1000,url:'https://youtu.be/new'});
  await f.run('!unpromote 1','cancel');await f.run('!unpromote 1','cancel');await f.run('!unpromote 1','another');
  assert.deepEqual(f.calls.map(row=>row.amount),[-450,450]);assert.equal(f.balance(),1000);
  assert.deepEqual(f.queue(),['v1','v2','v3','v4','v5','v6','v7','v8','v9','v10','new']);
  assert.match(promotionLabel(f.row('v10')),/450 points refunded/);assert.deepEqual(f.row('v0'),f.playing);
});
test('insufficient funds, already-next, and expired commands never debit; all ordinary viewers parse',async()=>{
  const f=setup({balance:20});await f.run('!promote 1','not-own');await f.run('!promote 10 450','poor');
  await f.run('!unpromote 1','not-own-cancel');assert.equal(f.calls.length,0);
  const g=setup({count:1});await g.run('!promote','next');assert.equal(g.calls.length,0);
  const event={broadcaster_user_login:'2o3a',chatter_user_login:'any_viewer',message:{text:'!promote 7'}};
  assert.equal(parseServerCommand(event).position,7);assert.equal(parseServerCommand({...event,chatter_user_login:'gachibot69'}),null);
  await persistChatCommand(f.db,{event,messageId:'expired',expiresAt:Date.now()-1},{points:{balance:()=>assert.fail('no API calls')},sendReply:async()=>({sent:true})});
});
test('once playback starts cancellation cannot refund; requeued/history requests cannot refund an old purchase',async()=>{
  const f=setup();await f.run('!promote 10 450','buy');await f.db.doc(prefix+'queue_videos/v10').update({status:'playing'});
  await f.run('!unpromote 1','playing');assert.equal(f.calls.length,1);
  await f.db.doc(prefix+'queue_videos/v10').update({status:'queue',timestamp:10000,queueOrder:50000});
  await f.run('!unpromote 10','replayed');assert.equal(f.calls.length,1);
});
test('simultaneous duplicate and different promotion commands serialize spending for a viewer',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);const f=setup({adjust:async()=>wait});
  const first=f.run('!promote 10 450','a');while(!f.calls.length)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.run('!promote 10 450','a'),/promotion_in_progress/);
  await f.run('!promote 10 450','b');assert.equal(f.calls.length,1);release();await first;assert.equal(f.calls.length,1);
});
test('ambiguous debit is quarantined; neither a retry nor a new command repeats the debit',async()=>{
  const f=setup({adjust:async()=>{throw Object.assign(Error('timeout'),{uncertain:true,code:'streamelements_unavailable'});}});
  await f.run('!promote 10 450','a');await f.run('!promote 10 450','a');await f.run('!promote 10 450','b');assert.equal(f.calls.length,1);assert.equal(f.queue()[0],'v1');
  assert.ok(Object.values(f.state().documents).some(row=>row.state==='charge_unknown'));
});
test('if target starts/disappears during debit it is refunded without changing playback',async()=>{
  let f;f=setup({adjust:async(_login,amount)=>{if(amount<0)await f.db.doc(prefix+'queue_videos/v10').update({status:'playing'});}});
  await f.run('!promote 10 450','race');assert.deepEqual(f.calls.map(row=>row.amount),[-450,450]);assert.equal(f.row('v10').status,'playing');assert.equal(f.balance(),1000);
});
test('ambiguous refund never credits twice and blocks further spending',async()=>{
  const f=setup({adjust:async(_login,amount)=>{if(amount>0)throw Object.assign(Error('timeout'),{uncertain:true});}});
  await f.run('!promote 10 450','buy');await f.run('!unpromote 1','cancel');await f.run('!unpromote 1','cancel');await f.run('!promote 10 450','again');
  assert.deepEqual(f.calls.map(row=>row.amount),[-450,450]);assert.equal(f.row('v10').promotion.state,'refunding');
});
test('cancellation does not jump ahead of a later paid promotion, and expired refund retries still finish',async()=>{
  const f=setup();await f.db.doc(prefix+'queue_videos/v9').update({requestedBy:'second_viewer'});
  await f.run('!promote 10 450','first');await f.run('!promote 10 450','second','second_viewer');
  assert.equal(f.queue()[0],'v9');await f.run('!vote 3','vote','third_viewer');assert.equal(f.queue()[0],'v9');await f.run('!unpromote 2','cancel-first');
  assert.equal(f.queue()[0],'v9');assert.equal(f.queue().at(-1),'v10');
  assert.deepEqual(f.calls.map(row=>row.amount),[-450,-450,450]);
});
test('any viewer without an approved profile can sponsor another viewer, and only the payer can cancel/refund',async()=>{
  const f=setup();await f.run('!promote #10 450','sponsored','unapproved_viewer');
  assert.equal(f.queue()[0],'v10');assert.equal(f.calls[0].login,'unapproved_viewer');assert.equal(f.calls[0].amount,-450);
  assert.equal(f.row('v10').requestedBy,'viewer');assert.match(promotionLabel(f.row('v10')),/@unapproved_viewer/);
  await f.run('!unpromote 1','wrong-payer','viewer');assert.equal(f.calls.length,1);
  await f.run('!unpromote 1','right-payer','unapproved_viewer');assert.equal(f.calls[1].login,'unapproved_viewer');assert.equal(f.calls[1].amount,450);
});
test('two different payers racing to sponsor the same video cannot both be charged',async()=>{
  let release;const wait=new Promise(resolve=>release=resolve);const f=setup({adjust:async()=>wait});
  const first=f.run('!promote 10 450','a','sponsor_a');while(!f.calls.length)await new Promise(resolve=>setImmediate(resolve));
  await f.run('!promote 10 450','b','sponsor_b');assert.equal(f.calls.length,1);release();await first;assert.equal(f.row('v10').promotion.paidBy,'sponsor_a');
});
test('multiple payers add priority; cancelling drops only the withdrawing payers purchased positions',async()=>{
  const f=setup();await f.run('!promote 10 150','small','sponsor_a');assert.equal(f.queue().indexOf('v10'),6);
  await f.run('!promote 7 300','large','sponsor_b');assert.equal(f.queue()[0],'v10');
  assert.equal(f.row('v10').promotion.points,450);assert.equal(f.row('v10').promotion.contributorCount,2);
  await f.run('!unpromote 1','cancel-a','sponsor_a');assert.equal(f.queue().indexOf('v10'),3);
  assert.equal(f.calls.at(-1).login,'sponsor_a');assert.equal(f.calls.at(-1).amount,150);
  assert.equal(f.row('v10').promotion.points,300);assert.match(promotionLabel(f.row('v10')),/300 points spent.*150 points refunded/);
  await f.run('!unpromote 4','cancel-b','sponsor_b');assert.equal(f.queue().at(-1),'v10');assert.equal(f.calls.at(-1).amount,300);
});
test('remaining contributors keep a video at the top if their funding is enough',async()=>{
  const f=setup();await f.run('!promote 10 450','first','sponsor_a');await f.run('!promote 1 450','second','sponsor_b');
  assert.equal(f.row('v10').promotion.points,900);await f.run('!unpromote 1','cancel-a','sponsor_a');
  assert.equal(f.queue()[0],'v10');assert.equal(f.row('v10').promotion.points,450);
  await f.run('!unpromote 1','repeat-a','sponsor_a');assert.equal(f.calls.length,3);
  await f.run('!unpromote 1','cancel-b','sponsor_b');assert.equal(f.queue().at(-1),'v10');
});
test('a payers repeated contributions refund together exactly once and invalid point amounts do not charge',async()=>{
  const f=setup();await f.run('!promote 10 150','first');await f.run('!promote 7 300','second');
  await f.run('!unpromote 1','cancel');await f.run('!unpromote 1','cancel');
  assert.deepEqual(f.calls.map(row=>row.amount),[-150,-300,450]);assert.equal(f.queue().at(-1),'v10');
  for(const [index,text]of ['!promote 10','!promote 10 55','!promote 10 0','!promote 10 9999999999'].entries())await f.run(text,'invalid-'+index);
  assert.equal(f.calls.length,3);
});
test('legacy single-payer promotions refund to the payer and restore their original slot',async()=>{
  const f=setup({balance:550});const row=f.row('v10');
  await f.db.doc(prefix+'queue_videos/v10').update({queueOrder:0,promotion:{id:'legacy',points:450,state:'active',paidBy:'viewer',requestTimestamp:110}});
  await f.db.doc(prefix+'point_purchases/legacy').set({id:'legacy',login:'viewer',requestedBy:'viewer',videoId:'v10',url:row.url,timestamp:110,playedAt:0,title:row.title,points:450,places:9,state:'fulfilled',createdAt:Date.now(),originalBefore:['v1','v2','v3','v4','v5','v6','v7','v8','v9'],originalAfter:[]});
  await f.run('!unpromote 1','cancel-legacy');assert.equal(f.calls[0].amount,450);assert.equal(f.queue().at(-1),'v10');assert.equal(f.balance(),1000);
});
test('refund acknowledged after normal playback advances updates the display without undoing playback',async()=>{
  let f;f=setup({adjust:async(_login,amount)=>{if(amount>0)await f.db.doc(prefix+'queue_videos/v10').update({status:'playing',playedAt:Date.now()});}});
  await f.run('!promote 10 450','buy');await f.run('!unpromote 1','cancel');
  assert.equal(f.row('v10').status,'playing');assert.match(promotionLabel(f.row('v10')),/450 points refunded/);
});
test('partial promotions stay in their purchased slot during votes and removed rows leave the priority baseline',async()=>{
  const f=setup();await f.run('!promote 10 50','one');assert.equal(f.queue().indexOf('v10'),8);
  await f.run('!vote 1','vote','third_viewer');assert.equal(f.queue().indexOf('v10'),8);
  await f.db.doc(prefix+'queue_videos/v5').delete();
  await f.run('!promote 8 350','more');assert.equal(f.queue()[0],'v10');
});
test('signed durable Twitch intake promotes another viewers video with no dashboard or staff profile',async t=>{
  const previous=process.env.TWITCH_EVENTSUB_SECRET;process.env.TWITCH_EVENTSUB_SECRET='promotion-test-signing-secret-0123456789';
  t.after(()=>{if(previous===undefined)delete process.env.TWITCH_EVENTSUB_SECRET;else process.env.TWITCH_EVENTSUB_SECRET=previous;});
  const f=setup();let payload;const changes=[];
  await bufferRequest({event:{broadcaster_user_login:'2o3a',chatter_user_login:'ordinary_sponsor',message:{text:'!promote 10 450'}},messageId:'signed-promotion',subscriptionId:'test-sub'}, {send:async(_topic,body)=>payload=body});
  assert.ok(payload);const dependencies={db:f.db,points:{balance:async()=>1000,adjust:async(login,amount)=>changes.push({login,amount})},sendReply:async()=>({sent:true})};
  await consumeRequest(payload,dependencies);await consumeRequest(payload,dependencies);
  assert.deepEqual(changes,[{login:'ordinary_sponsor',amount:-450}]);assert.equal(f.queue()[0],'v10');assert.deepEqual(f.row('v0'),f.playing);
});
test('a definite refund failure can resume after command expiry without issuing another debit',async()=>{
  let attempts=0;const f=setup({adjust:async(_login,amount)=>{if(amount>0 && ++attempts===1)throw Object.assign(Error('unauthorized'),{code:'streamelements_authorization_required'});}});
  await f.run('!promote 10 450','buy');await assert.rejects(f.run('!unpromote 1','refund'),/promotion_in_progress/);
  const event={broadcaster_user_login:'2o3a',chatter_user_login:'viewer',message:{text:'!unpromote 1'}};
  await persistChatCommand(f.db,{event,messageId:'refund',expiresAt:Date.now()-1000},{points:{balance:async()=>assert.fail('refund must not check/debit balance'),adjust:async(_login,amount)=>{assert.equal(amount,450);}},sendReply:async()=>({sent:true})});
  assert.equal(f.row('v10').promotion.state,'refunded');
});
test('recovered in-flight charge/refund markers are quarantined without repeating the external write',async()=>{
  const f=setup();await f.run('!promote 10 450','buy');
  const path=Object.keys(f.state().documents).find(path=>path.includes('/point_purchases/'));
  const id=path.split('/').at(-1);await f.db.doc(prefix+'twitch_eventsub_receipts/'+id).delete();
  await f.db.doc(path).update({state:'charging',updatedAt:Date.now()-120000});
  await f.run('!promote 10 450','buy');assert.equal(f.calls.length,1);assert.equal(f.state().documents[path].state,'charge_unknown');
});
test('points API targets 2o3a Twitch channel, uses a server Bearer token, and never retries ambiguous writes',async()=>{
  const calls=[];const client=createPointsClient({token:'test-token',request:async(url,options)=>{
    calls.push({url,options});if(url.includes('/channels/'))return{ok:true,json:async()=>({_id:'0123456789abcdef01234567',username:'2o3a',provider:'twitch'})};
    if(options.method==='PUT')throw Error('network');return{ok:true,json:async()=>({points:1000})};
  }});
  assert.equal(await client.balance('viewer'),1000);await assert.rejects(client.adjust('viewer',-450),error=>error.uncertain===true);
  assert.equal(calls.filter(row=>row.options.method==='PUT').length,1);assert.match(calls.at(-1).url,/\/viewer\/-450$/);
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer test-token');
  const wrong=createPointsClient({token:'test',request:async()=>({ok:true,json:async()=>({_id:'0123456789abcdef01234567',username:'other',provider:'twitch'})})});
  await assert.rejects(wrong.balance('viewer'),/wrong_channel/);
});
test('points journals are private to paim; client writes cannot forge or erase promotion fields',async()=>{
  const f=setup();await f.run('!promote 10 450','buy');
  const call=async(login,method='GET',body)=>{const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await handlePrivateStore({method,query:{view:'points'},headers:{host:'203a.vercel.app',origin:'https://203a.vercel.app'},body},res,{login},{db:f.db,namespace});return res;};
  assert.equal((await call('2o3a')).code,403);assert.equal((await call('viewer')).code,403);assert.equal((await call('paim_beach_pete')).body.purchases[0].points,450);
  const path=prefix+'queue_videos/v10',promotion=structuredClone(f.row('v10').promotion);
  const res=await call('2o3a','POST',{expectedVersion:f.state().version,expectations:{[path]:{exists:true,status:'queue',timestamp:110}},operations:[{type:'set',path,data:{...f.row('v10'),promotion:{points:1,state:'refunded'}}}]});
  assert.equal(res.code,200);assert.deepEqual(f.row('v10').promotion,promotion);
});
