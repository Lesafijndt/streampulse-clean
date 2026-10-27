import {applyPromotionOrder, summarizeFunding, legacyPromotionPriority} from './promotion-order.js';
import { createPointsClient } from './streamelements-points.js';
import { PROMOTION_RATE, isActivePromotion } from '../src/promotion.js';

const order = (a,b) => Number(a.queueOrder ?? a.timestamp ?? 0)-Number(b.queueOrder ?? b.timestamp ?? 0) || Number(a.timestamp || 0)-Number(b.timestamp || 0) || a.id.localeCompare(b.id);
const owner = row => String(row?.requestedBy || '').replace(/^@/,'').trim().toLowerCase();
const retry = () => { throw Object.assign(Error('promotion_in_progress'), {code:'promotion_in_progress'}); };
const unfinished = new Set(['reserved','charging','charged','refund_ready','refunding','refund_acknowledged','charge_unknown','refund_unknown']);
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
  const roomRef=db.doc(prefix+'room_settings/2o3a');
  const sameRequest=(row,target)=>row.timestamp===Number(target.timestamp || 0) && row.url===target.url && Number(row.playedAt || 0)===Number(target.playedAt || 0);
  const contributions=async(tx,target)=>{const snapshot=await tx.get(journal.where('videoId','==',target.id).where('timestamp','==',Number(target.timestamp || 0)));return snapshot.docs.map(row=>row.data()).filter(row=>sameRequest(row,target));};
  const reorder=async(tx,queue,target,promotion,settings)=>{
    let baseline=settings.promotionPriority;
    const legacy=queue.filter(row=>isActivePromotion(row) && row.promotion.version!==2 && row.promotion.id);
    if(!baseline?.applied && legacy.length){
      const snapshots=await Promise.all(legacy.map(row=>tx.get(db.doc(prefix+'point_purchases/'+row.promotion.id))));
      baseline=legacyPromotionPriority(queue,snapshots.map(row=>row.data()).filter(Boolean));
    }
    const transition=applyPromotionOrder(queue,target,promotion,baseline);
    transition.rows.forEach((row,index)=>tx.update(db.doc(prefix+'queue_videos/'+row.id),{queueOrder:(index+1)*1000,...(row.id===target.id ? {promotion} : {})}));
    tx.set(roomRef,{...settings,promotionPriority:transition.priority});
    return transition.rows.findIndex(row=>row.id===target.id)+1;
  };
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
    if (saved.exists && !dependencies.resumePayment) return {result:saved.data()};
    const [purchases, videos, existingRow] = await Promise.all([tx.get(journal.where('login','==',command.login).where('state','in',[...unfinished]).limit(1)),tx.get(collection),tx.get(purchaseRef)]);
    const existing = existingRow.data();
    if (existing) return {purchase:existing};
    // New spending commands expire; an already-authorized debit/refund must finish.
    const reject = reply => {const result=outcome(reply);tx.create(receipt,result);return {result};};
    if (Number.isFinite(expiresAt) && now()>expiresAt) return reject('That command expired. Please send it again.');
    const rows=videos.docs.map(row=>({...row.data(),id:row.id})).filter(row=>row.channelRoom==='2o3a');
    const queue=rows.filter(row=>row.status==='queue').sort(order);
    const pending=purchases.docs.map(row=>({...row.data(),id:row.id})).find(row=>row.login===command.login && unfinished.has(row.state));
    if (pending) return reject('Your previous points transaction is still pending. Please wait; do not repeat it.');
    if (!Number.isInteger(command.position) || command.position<1 || (command.type==='promote' && (!Number.isSafeInteger(command.points) || command.points<50 || command.points>2147483647 || command.points%PROMOTION_RATE!==0))) return reject('Use !qpromote <queue position> <points>, in multiples of 50. Cancel your contribution with !qunpromote <queue position>.');
    const target=queue[command.position-1];
    if (!target) return reject('There is no waiting video at that position.');
    const funding=await contributions(tx,target);
    if(funding.some(row=>unfinished.has(row.state)))return reject('That video has a points transaction pending. Please wait.');
    let purchase;
    if (command.type==='unpromote') {
      const own=funding.filter(row=>row.state==='fulfilled' && row.login===command.login && !row.originalPurchaseId && !row.originalPurchaseIds);
      if (!own.length || own.some(row=>changedRequest(target,row))) return reject('You have no refundable contribution to that waiting video.');
      const price=own.reduce((sum,row)=>sum+row.points,0);
      if(!Number.isSafeInteger(price) || price>2147483647)return reject('That refund requires moderator review.');
      purchase={...own[0],id,kind:'refund',originalPurchaseIds:own.map(row=>row.id),points:price,places:price/PROMOTION_RATE,state:'refund_ready',createdAt:now(),cancelledAt:now()};
      const active=funding.filter(row=>row.state==='fulfilled' && row.login!==command.login);
      const refunds=[...funding.filter(row=>row.kind==='refund' || row.originalPurchaseId || row.originalPurchaseIds),purchase];
      const settings=(await tx.get(roomRef)).data() || {channelRoom:'2o3a'};
      await reorder(tx,queue,target,summarizeFunding(active,refunds,target,now()),settings);
      own.forEach(row=>tx.update(db.doc(prefix+'point_purchases/'+row.id),{state:'cancelled',cancelledAt:now()}));
    } else {
      const cost=command.points,places=cost/PROMOTION_RATE;
      const active=funding.filter(row=>row.state==='fulfilled' && !row.originalPurchaseId && !row.originalPurchaseIds);
      if(active.reduce((sum,row)=>sum+row.points,0)+cost>2147483647)return reject('That video has reached its points limit. No points charged.');
      purchase={id,kind:'promotion',login:command.login,requestedBy:owner(target),videoId:target.id,url:target.url,timestamp:Number(target.timestamp || 0),playedAt:Number(target.playedAt || 0),title:String(target.title || 'Video').slice(0,200),points:cost,places,state:'reserved',createdAt:now()};
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
      if (changedRequest(target,purchase)) {tx.update(purchaseRef,{state:'refund_ready',kind:'refund',originalPurchaseIds:[]});return 'refund_ready';}
      const funding=await contributions(tx,target);
      const active=[...funding.filter(row=>row.state==='fulfilled' && !row.originalPurchaseId && !row.originalPurchaseIds),{...purchase,state:'fulfilled'}];
      const refunds=funding.filter(row=>row.kind==='refund' || row.originalPurchaseId || row.originalPurchaseIds);
      const settings=(await tx.get(roomRef)).data() || {channelRoom:'2o3a'};
      const transitionPosition=await reorder(tx,queue,target,summarizeFunding(active,refunds,target,now()),settings);
      tx.update(purchaseRef,{state:'fulfilled',fulfilledAt:now(),position:transitionPosition});return 'fulfilled';
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
    await save({state:'refund_acknowledged'});
  }
  if (purchase.state==='refund_acknowledged') {
    await completePromotionRefund(db,prefix,purchase,now);
    purchase.state='refunded';
  }
  if (purchase.state==='fulfilled') {
    const final=(await purchaseRef.get()).data();
    return finish('Promoted '+purchase.title+' for '+purchase.points+' points. New position: #'+final.position+'. Cancel before playback: !qunpromote '+final.position+'.');
  }
  if (purchase.state==='refunded') return finish('Promotion cancelled; '+purchase.points+' points refunded.');
  if (['charge_unknown','refund_unknown'].includes(purchase.state)) return finish('Your points transaction needs review. Please do not repeat it.');
  return finish('The promotion was not applied. No further points were charged.');
}

export async function completePromotionRefund(db,prefix,purchase,now=Date.now) {
  const id=purchase.id, journal=db.collection(prefix+'point_purchases'), purchaseRef=db.doc(prefix+'point_purchases/'+id);
  await db.runTransaction(async tx=>{
    const current=(await tx.get(purchaseRef)).data();
    if(current?.state==='refunded')return;
    if(current?.state!=='refund_acknowledged')throw Object.assign(Error('payment_state_changed'),{code:'payment_state_changed',status:409});
    const videoRef=db.doc(prefix+'queue_videos/'+purchase.videoId),row=(await tx.get(videoRef)).data();
    if(row && Number(row.timestamp || 0)===purchase.timestamp && row.url===purchase.url && owner(row)===purchase.requestedBy){
      const records=await tx.get(journal.where('videoId','==',purchase.videoId).where('timestamp','==',purchase.timestamp));
      const funding=records.docs.map(entry=>entry.data()).filter(entry=>entry.url===purchase.url && Number(entry.playedAt || 0)===Number(purchase.playedAt || 0));
      const active=funding.filter(entry=>entry.state==='fulfilled' && !entry.originalPurchaseId && !entry.originalPurchaseIds);
      const refunds=funding.filter(entry=>(entry.kind==='refund' || entry.originalPurchaseId || entry.originalPurchaseIds) && entry.id!==id);
      refunds.push({...purchase,state:'refunded',kind:'refund'});
      tx.update(videoRef,{promotion:summarizeFunding(active,refunds,row,now())});
    }
    tx.update(purchaseRef,{state:'refunded',refundedAt:now(),updatedAt:now()});
  });
}
