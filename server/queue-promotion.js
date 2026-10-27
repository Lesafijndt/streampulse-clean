import { createPointsClient } from './streamelements-points.js';
import { PROMOTION_RATE, isActivePromotion } from '../src/promotion.js';

const order = (a,b) => Number(a.queueOrder ?? a.timestamp ?? 0)-Number(b.queueOrder ?? b.timestamp ?? 0) || Number(a.timestamp || 0)-Number(b.timestamp || 0) || a.id.localeCompare(b.id);
const owner = row => String(row?.requestedBy || '').replace(/^@/,'').trim().toLowerCase();
const retry = () => { throw Object.assign(Error('promotion_in_progress'), {code:'promotion_in_progress'}); };
const unfinished = new Set(['reserved','charging','charged','refund_ready','refunding','charge_unknown','refund_unknown']);
const changedRequest = (row, purchase) => !row || row.channelRoom !== '2o3a' || owner(row) !== purchase.requestedBy || row.url !== purchase.url || Number(row.timestamp || 0) !== purchase.timestamp || row.status !== 'queue' || Number(row.playedAt || 0) !== Number(purchase.playedAt || 0);

// External point changes happen ONLY outside retryable database callbacks.
// A durable 'charging/refunding' marker is committed before each PUT. An ambiguous
// response/crash is never automatically retried: doing so could double debit/refund.
export async function processPromotion(db, prefix, command, id, expiresAt, dependencies = {}) {
  const points = dependencies.points || createPointsClient();
  const now = dependencies.now || Date.now;
  const receipt = db.doc(prefix+'twitch_eventsub_receipts/'+id);
  const journal = db.collection(prefix+'point_purchases');
  const collection = db.collection(prefix+'queue_videos');
  const purchaseRef = db.doc(prefix+'point_purchases/'+id);
  const outcome = (reply) => ({status:'command_processed',command:command.type,sender:command.login,receivedAt:now(),queued:0,reply:reply ? '@'+command.login+' '+reply : ''});
  const finish = async (reply) => {
    const result = outcome(reply);
    return db.runTransaction(async tx => {
      const saved = await tx.get(receipt);
      if (saved.exists) return saved.data();
      tx.create(receipt,result);return result;
    });
  };
  const prepared = await db.runTransaction(async tx => {
    const saved = await tx.get(receipt);
    if (saved.exists) return {result:saved.data()};
    const [purchases, videos, existingRow] = await Promise.all([tx.get(journal.where('login','==',command.login).orderBy('createdAt','desc').limit(1)),tx.get(collection),tx.get(purchaseRef)]);
    const existing = existingRow.data();
    if (existing) return {purchase:existing};
    // New spending commands expire; an already-authorized debit/refund must finish.
    const reject = reply => {const result=outcome(reply);tx.create(receipt,result);return {result};};
    if (Number.isFinite(expiresAt) && now()>expiresAt) return reject('That command expired. Please send it again.');
    const rows=videos.docs.map(row=>({...row.data(),id:row.id})).filter(row=>row.channelRoom==='2o3a');
    const queue=rows.filter(row=>row.status==='queue').sort(order);
    const pending=purchases.docs.map(row=>({...row.data(),id:row.id})).find(row=>row.login===command.login && unfinished.has(row.state));
    if (pending) return reject('Your previous points transaction is still pending. Please wait; do not repeat it.');
    const target=command.position ? queue[command.position-1] : queue.find(row=>command.type==='unpromote' ? isActivePromotion(row) && row.promotion?.paidBy===command.login : owner(row)===command.login);
    if (!target) return reject('Choose a waiting video using !'+command.type+' <queue position>.');
    const targetPurchase=(await tx.get(journal.where('videoId','==',target.id).orderBy('createdAt','desc').limit(1))).docs[0]?.data();
    if(targetPurchase && unfinished.has(targetPurchase.state))return reject('That video already has a points transaction pending. Please wait.');
    let purchase;
    if (command.type==='unpromote') {
      const previous=target.promotion?.id ? (await tx.get(db.doc(prefix+'point_purchases/'+target.promotion.id))).data() : null;
      if (!previous || previous.state!=='fulfilled' || previous.login!==command.login || !isActivePromotion(target) || changedRequest(target,previous)) return reject('That video has no refundable promotion. Only waiting videos can be cancelled.');
      // Reserve cancellation while still waiting. It is effective now, even if the
      // normal queue advances while the refund request is in flight.
      purchase={...previous,id,originalPurchaseId:previous.id,state:'refund_ready',createdAt:now(),cancelledAt:now()};
      tx.update(db.doc(prefix+'point_purchases/'+previous.id),{state:'cancelled'});
      const remaining=queue.filter(row=>row.id!==target.id);
      const successor=previous.originalAfter?.find(key=>remaining.some(row=>row.id===key && !isActivePromotion(row)));
      const predecessor=[...(previous.originalBefore || [])].reverse().find(key=>remaining.some(row=>row.id===key && !isActivePromotion(row)));
      const insert=successor ? remaining.findIndex(row=>row.id===successor) : predecessor ? remaining.findIndex(row=>row.id===predecessor)+1 : remaining.length;
      const lastPromoted=remaining.reduce((last,row,index)=>isActivePromotion(row) ? index : last,-1);
      remaining.splice(Math.max(insert,lastPromoted+1),0,target);
      remaining.forEach((row,index)=>tx.update(db.doc(prefix+'queue_videos/'+row.id),{queueOrder:(index+1)*1000,...(row.id===target.id ? {promotion:{...target.promotion,state:'refunding'}} : {})}));
    } else {
      if (queue[0]?.id===target.id) return reject('Your video is already next up. No points charged.');
      if (isActivePromotion(target) || target.promotion?.state==='refunding') return reject('That video already has a promotion. No points charged.');
      const index=queue.findIndex(row=>row.id===target.id);
      const places=index,cost=places*PROMOTION_RATE;
      if (!Number.isSafeInteger(cost) || cost<=0 || cost>2147483647) return reject('That video cannot be priced safely. No points charged.');
      purchase={id,login:command.login,requestedBy:owner(target),videoId:target.id,url:target.url,timestamp:Number(target.timestamp || 0),playedAt:Number(target.playedAt || 0),title:String(target.title || 'Video').slice(0,200),points:cost,places,state:'reserved',createdAt:now(),originalBefore:queue.slice(0,index).map(row=>row.id),originalAfter:queue.slice(index+1).map(row=>row.id)};
    }
    tx.create(purchaseRef,purchase);
    return {purchase};
  });
  if (prepared.result) return prepared.result;
  let purchase=prepared.purchase;
  const save = async patch => {
    const expected=purchase.state;
    const result=await db.runTransaction(async tx=>{
      const current=(await tx.get(purchaseRef)).data();
      if(current.state!==expected)return {saved:false,purchase:current};
      const next={...current,...patch,updatedAt:now()};
      tx.update(purchaseRef,next);return {saved:true,purchase:next};
    });
    purchase=result.purchase;return result.saved;
  };
  const diagnose = async code => {
    await db.doc(prefix+'system_diagnostics/points-'+id).set({id,code,login:purchase.login,videoId:purchase.videoId,points:purchase.points,state:purchase.state,at:now()});
  };
  if (purchase.state==='reserved') {
    let balance;
    try {balance=await points.balance(purchase.login);} catch(error) {
      if(!await save({state:'failed',code:error.code || 'streamelements_unavailable'}))return processPromotion(db,prefix,command,id,expiresAt,dependencies);
      await diagnose(purchase.code);
      return finish('Promotions are temporarily unavailable. No points charged.');
    }
    if (balance<purchase.points) {
      if(!await save({state:'failed',code:'insufficient_points'}))return processPromotion(db,prefix,command,id,expiresAt,dependencies);
      return finish('You need '+purchase.points+' points for this video ('+purchase.places+' positions at 50 points/position). No points charged.');
    }
    const claimed=await db.runTransaction(async tx=>{
      const current=(await tx.get(purchaseRef)).data();
      const video=(await tx.get(db.doc(prefix+'queue_videos/'+purchase.videoId))).data();
      if (current.state!=='reserved') return false;
      if (changedRequest(video,purchase)) {tx.update(purchaseRef,{state:'failed',code:'request_changed'});return false;}
      tx.update(purchaseRef,{state:'charging',updatedAt:now()});return true;
    });
    if (!claimed) return processPromotion(db,prefix,command,id,expiresAt,dependencies);
    purchase.state='charging';
    try {await points.adjust(purchase.login,-purchase.points);}
    catch(error) {
      await save({state:error.uncertain ? 'charge_unknown':'failed',code:error.code || 'points_charge_failed'});await diagnose(purchase.code);
      return finish(error.uncertain ? 'The points transaction needs review. Please do not retry it.' : 'The promotion could not be charged. No queue change was made.');
    }
    await save({state:'charged'});
  } else if (['charging','refunding'].includes(purchase.state)) {
    if (now()-Number(purchase.updatedAt || purchase.createdAt)<60000) retry();
    await save({state:purchase.state==='charging' ? 'charge_unknown':'refund_unknown',code:'points_acknowledgement_missing'});
    await diagnose(purchase.code);
  }
  if (purchase.state==='charged') {
    const state=await db.runTransaction(async tx=>{
      const saved=(await tx.get(purchaseRef)).data();
      if (saved.state!=='charged') return saved.state;
      const videos=await tx.get(collection);
      const queue=videos.docs.map(row=>({...row.data(),id:row.id})).filter(row=>row.channelRoom==='2o3a' && row.status==='queue').sort(order);
      const target=queue.find(row=>row.id===purchase.videoId);
      if (changedRequest(target,purchase) || queue[0]?.id===target?.id) {tx.update(purchaseRef,{state:'refund_ready'});return 'refund_ready';}
      const reordered=[target,...queue.filter(row=>row.id!==target.id)];
      reordered.forEach((row,index)=>tx.update(db.doc(prefix+'queue_videos/'+row.id),{queueOrder:(index+1)*1000,...(row.id===target.id ? {promotion:{id,points:purchase.points,state:'active',paidBy:purchase.login,at:now(),requestTimestamp:purchase.timestamp}} : {})}));
      tx.update(purchaseRef,{state:'fulfilled',fulfilledAt:now()});return 'fulfilled';
    });
    purchase.state=state;
  }
  if (purchase.state==='refund_ready') {
    const claimed=await db.runTransaction(async tx=>{
      const saved=(await tx.get(purchaseRef)).data();
      if (saved.state!=='refund_ready') return false;
      tx.update(purchaseRef,{state:'refunding',updatedAt:now()});return true;
    });
    if (!claimed) return processPromotion(db,prefix,command,id,expiresAt,dependencies);
    purchase.state='refunding';
    try {await points.adjust(purchase.login,purchase.points);}
    catch(error) {
      // A definite rejection is safe to retry later; an unknown result is not.
      await save({state:error.uncertain ? 'refund_unknown':'refund_ready',code:error.code || 'points_refund_failed'});await diagnose(purchase.code);
      if (!error.uncertain) retry();
      return finish('The refund needs review. Please do not repeat the cancellation.');
    }
    await db.runTransaction(async tx=>{
      const videoRef=db.doc(prefix+'queue_videos/'+purchase.videoId);
      const row=(await tx.get(videoRef)).data();
      tx.update(purchaseRef,{state:'refunded',refundedAt:now()});
      if (row?.promotion?.id===(purchase.originalPurchaseId || id) && row.promotion.state==='refunding') tx.update(videoRef,{promotion:{...row.promotion,state:'refunded'}});
    });
    purchase.state='refunded';
  }
  if (purchase.state==='fulfilled') return finish('Promoted '+purchase.title+' to next up for '+purchase.points+' points. Cancel before it starts with !unpromote.');
  if (purchase.state==='refunded') return finish('Promotion cancelled; '+purchase.points+' points refunded.');
  if (['charge_unknown','refund_unknown'].includes(purchase.state)) return finish('Your points transaction needs review. Please do not repeat it.');
  return finish('The promotion was not applied. No further points were charged.');
}
