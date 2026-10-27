import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentStore} from '../server/postgres-store.js';
import {persistChatCommand,parseServerCommand} from '../server/chat-commands.js';
import {recoverPointsPayment} from '../server/points-recovery.js';
import {readPromotionDetails} from '../server/promotion-details.js';
import {applyPromotionOrder,promotionQuotes} from '../src/promotionPriority.js';
import {handlePrivateStore} from '../server/private-store-api.js';

const namespace=process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck',prefix=`artifacts/${namespace}/public/data/`;
function fixture() {
  let state={version:0,documents:{}};
  const db=createDocumentStore({namespace,readState:async()=>structuredClone(state),compareAndSwap:async(v,documents)=>{if(v!==state.version)return false;state={version:v+1,documents:structuredClone(documents)};return true;}});
  for(let i=0;i<5;i++)state.documents[prefix+'queue_videos/v'+i]={id:'v'+i,channelRoom:'2o3a',status:i===0?'playing':'queue',requestedBy:'requester',url:'https://youtu.be/'+i,timestamp:100+i,queueOrder:i*1000,playedAt:i===0?50:0,title:'Video '+i};
  const calls=[],replies=[];let ambiguousDebit=false,ambiguousRefund=false;
  const points={balance:async()=>10000,adjust:async(login,amount)=>{calls.push({login,amount});if(amount<0&&ambiguousDebit || amount>0&&ambiguousRefund)throw Object.assign(Error('timeout'),{code:'streamelements_unavailable',uncertain:true});}};
  const run=(text,messageId,login='payer')=>persistChatCommand(db,{event:{broadcaster_user_login:'2o3a',chatter_user_login:login,message:{text}},messageId},{points,sendReply:async text=>{replies.push(text);return{sent:true}}});
  const purchases=()=>Object.entries(state.documents).filter(([path])=>path.startsWith(prefix+'point_purchases/')).map(([,row])=>row);
  const recovery=(purchase,resolution,extra={},login='paim_beach_pete')=>recoverPointsPayment(db,prefix,{login},{id:purchase.id,expectedState:purchase.state,expectedAt:purchase.updatedAt || purchase.createdAt,resolution,confirmation:resolution==='resume'?'RESUME':'VERIFIED',evidence:'Verified StreamElements account record',...extra},{points});
  return {db,run,points,calls,replies,purchases,recovery,state:()=>state,ambiguous:(debit,refund)=>{ambiguousDebit=debit;ambiguousRefund=refund;},row:id=>state.documents[prefix+'queue_videos/'+id]};
}
test('q-prefixed commands avoid Nightbot aliases and confirmations include title, exact charge and new position',async()=>{
  const f=fixture();for(const text of ['!promote 4 150','!unpromote 1'])assert.equal(parseServerCommand({broadcaster_user_login:'2o3a',chatter_user_login:'payer',message:{text}}),null);
  await f.run('!qpromote 4 150','charge');assert.match(f.replies[0],/Video 4.*150 points.*New position: #1.*!qunpromote 1/);
});
test('estimated next-up price matches the real ranking calculation and accounts for competing funding',()=>{
  let queue=Array.from({length:8},(_,index)=>({id:'v'+index,timestamp:10+index,queueOrder:(index+1)*1000,status:'queue'})),priority={};
  for(let round=0;round<50;round++) {
    const target=queue[(round*7+3)%queue.length],points=Number(target.promotion?.points || 0)+(round%7+1)*50;
    const transition=applyPromotionOrder(queue,target,{state:'active',points,requestTimestamp:target.timestamp},priority);
    queue=transition.rows;priority=transition.priority;
    const quotes=promotionQuotes(queue,priority);
    for(const [index,row]of queue.entries()) {
      const quote=quotes.get(row.id);if(index===0){assert.equal(quote.points,0);continue;}
      const promoted={state:'active',points:Number(row.promotion?.points || 0)+quote.points,requestTimestamp:row.timestamp};
      assert.equal(applyPromotionOrder(queue,row,promoted,priority).rows[0].id,row.id,'quote must reach next up');
      if(quote.points>50)assert.notEqual(applyPromotionOrder(queue,row,{...promoted,points:promoted.points-50},priority).rows[0].id,row.id,'quote must not overcharge by one position');
      assert.equal(quote.command,'!qpromote '+(index+1)+' '+quote.points);
    }
  }
});
test('contributor details show active/refunded amounts and expose no journal secrets or recovery fields',async()=>{
  const f=fixture();await f.run('!qpromote 4 50','a','alice');await f.run('!qpromote 3 100','b','bob');await f.run('!qunpromote 1','cancel','alice');
  const purchase=f.purchases()[0];await f.db.doc(prefix+'point_purchases/'+purchase.id).update({token:'PRIVATE_TOKEN',code:'PRIVATE_DIAGNOSTIC'});
  const details=await readPromotionDetails(f.db,prefix,{id:'v4',timestamp:104});
  assert.deepEqual(details.contributors,[{login:'bob',activePoints:100,refundedPoints:0,pendingRefundPoints:0},{login:'alice',activePoints:0,refundedPoints:50,pendingRefundPoints:0}]);
  assert.equal(JSON.stringify(details).includes('PRIVATE'),false);assert.equal(JSON.stringify(details).includes(purchase.id),false);
  await f.db.doc(prefix+'queue_videos/v4').update({status:'watched'});
  await assert.rejects(readPromotionDetails(f.db,prefix,{id:'v4',timestamp:104}),error=>error.status===404);
  assert.equal((await readPromotionDetails(f.db,prefix,{id:'v4',timestamp:104},true)).activePoints,100);
  await assert.rejects(readPromotionDetails(f.db,prefix,{id:'v4',timestamp:999},true),error=>error.status===404);
});
test('verified charged recovery fulfils without charging again, audits the decision, and rejects stale replay',async()=>{
  const f=fixture();f.ambiguous(true,false);await f.run('!qpromote 4 150','unknown');const purchase=structuredClone(f.purchases()[0]);
  assert.equal(purchase.state,'charge_unknown');const playing=structuredClone(f.row('v0'));
  await assert.rejects(f.recovery(purchase,'charge_confirmed',{},'2o3a'),error=>error.status===403);
  await assert.rejects(f.recovery(purchase,'charge_confirmed',{confirmation:''}),/verification_required/);
  await assert.rejects(f.recovery(purchase,'charge_confirmed',{evidence:'short'}),/verification_required/);
  assert.equal((await f.recovery(purchase,'charge_confirmed')).state,'fulfilled');assert.equal(f.calls.length,1);assert.deepEqual(f.row('v0'),playing);
  assert.ok(Object.values(f.state().documents).some(row=>row.resolution==='charge_confirmed' && row.actor==='paim_beach_pete'));
  await assert.rejects(f.recovery(purchase,'charge_confirmed'),error=>error.status===409);assert.equal(f.calls.length,1);
});
test('verified absent charge unlocks the payer without any external write or queue change',async()=>{
  const f=fixture();f.ambiguous(true,false);await f.run('!qpromote 4 150','unknown');
  assert.equal((await f.recovery(f.purchases()[0],'charge_absent')).state,'failed');assert.equal(f.calls.length,1);assert.equal(f.row('v4').queueOrder,4000);
  f.ambiguous(false,false);await f.run('!qpromote 4 150','new');assert.equal(f.calls.length,2);
});
test('verified charge for a request that already started is refunded without interrupting playback',async()=>{
  const f=fixture();f.ambiguous(true,false);await f.run('!qpromote 4 150','unknown');const purchase=f.purchases()[0];
  await f.db.doc(prefix+'queue_videos/v4').update({status:'playing',playedAt:999});f.ambiguous(false,false);
  assert.equal((await f.recovery(purchase,'charge_confirmed')).state,'refunded');assert.deepEqual(f.calls.map(row=>row.amount),[-150,150]);assert.equal(f.row('v4').status,'playing');assert.equal(f.row('v4').playedAt,999);
});
test('competing recovery decisions are guarded by the same payment state and cannot both commit',async()=>{
  const f=fixture();f.ambiguous(true,false);await f.run('!qpromote 4 150','unknown');const purchase=structuredClone(f.purchases()[0]);
  const results=await Promise.allSettled([f.recovery(purchase,'charge_confirmed'),f.recovery(purchase,'charge_absent')]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected'&&row.reason.status===409).length,1);assert.equal(f.calls.length,1);
  assert.equal(Object.keys(f.state().documents).filter(path=>path.includes('/points_reconciliations/')).length,1);
});
test('verified received refund settles metadata without crediting twice',async()=>{
  const f=fixture();await f.run('!qpromote 4 150','buy');f.ambiguous(false,true);await f.run('!qunpromote 1','refund');
  const refund=f.purchases().find(row=>row.state==='refund_unknown');assert.equal((await f.recovery(refund,'refund_confirmed')).state,'refunded');
  assert.deepEqual(f.calls.map(row=>row.amount),[-150,150]);assert.equal(f.row('v4').promotion.refundedPoints,150);
});
test('verified missing refund is issued once and an acknowledged refund resumes with no external write',async()=>{
  const f=fixture();await f.run('!qpromote 4 150','buy');f.ambiguous(false,true);await f.run('!qunpromote 1','refund');
  const refund=structuredClone(f.purchases().find(row=>row.state==='refund_unknown'));f.ambiguous(false,false);
  assert.equal((await f.recovery(refund,'refund_absent')).state,'refunded');assert.deepEqual(f.calls.map(row=>row.amount),[-150,150,150]);
  await assert.rejects(f.recovery(refund,'refund_absent'),error=>error.status===409);
  await f.db.doc(prefix+'point_purchases/'+refund.id).update({state:'refund_acknowledged'});
  const acknowledged=f.purchases().find(row=>row.id===refund.id);assert.equal((await f.recovery(acknowledged,'resume')).state,'refunded');assert.equal(f.calls.length,3);
});
test('payment recovery HTTP API is paim-only and enforces same-origin posts',async()=>{
  const f=fixture();const api=async(login,origin)=>{const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handlePrivateStore({method:'POST',headers:{host:'203a.vercel.app',origin},body:{operation:'recover-points'}},res,{login},{db:f.db,namespace});return res;};
  assert.equal((await api('2o3a','https://203a.vercel.app')).code,403);assert.equal((await api('viewer','https://203a.vercel.app')).code,403);assert.equal((await api('paim_beach_pete','https://evil.example')).code,403);
});
