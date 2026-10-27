import {isActivePromotion, PROMOTION_RATE} from './promotion.js';

const key = row => String(row.id)+':'+String(row.timestamp || 0);
const units = row => isActivePromotion(row) ? row.promotion.points/PROMOTION_RATE : 0;

export function legacyPromotionPriority(queue, purchases) {
  const restored=[...queue];
  for(const purchase of [...purchases].sort((a,b)=>b.createdAt-a.createdAt)) {
    const index=restored.findIndex(row=>row.id===purchase.videoId && Number(row.timestamp || 0)===purchase.timestamp);
    if(index<0)continue;
    const [target]=restored.splice(index,1);
    const after=purchase.originalAfter?.find(id=>restored.some(row=>row.id===id));
    const before=[...(purchase.originalBefore || [])].reverse().find(id=>restored.some(row=>row.id===id));
    const slot=after ? restored.findIndex(row=>row.id===after) : before ? restored.findIndex(row=>row.id===before)+1 : restored.length;
    restored.splice(slot,0,target);
  }
  return {baseline:restored.map((row,index)=>[key(row),index]),applied:queue.map(key)};
}

// Keep an organic position separate from paid priority. Paying subtracts units
// from that position; cancelling adds back only the withdrawing payer's units.
// Explicit streamer reordering rebases organic positions without losing funding.
export function applyPromotionOrder(queue, target, promotion, saved = {}) {
  saved=saved && typeof saved==='object' ? saved : {};
  const keys=queue.map(key), present=new Set(keys);
  const previous=Array.isArray(saved.applied) ? saved.applied : [];
  const previousSet=new Set(previous);
  const retained=previous.filter(id=>present.has(id));
  const currentRetained=keys.filter(id=>previousSet.has(id));
  const baseline=new Map(Array.isArray(saved.baseline) ? saved.baseline.filter(entry=>Array.isArray(entry)&&typeof entry[0]==='string'&&Number.isFinite(entry[1])) : []);
  const unchanged=previous.length && JSON.stringify(retained)===JSON.stringify(currentRetained) && JSON.stringify(keys.slice(0,retained.length))===JSON.stringify(retained) && retained.every(id=>baseline.has(id));
  if (!unchanged) {
    baseline.clear();queue.forEach((row,index)=>baseline.set(key(row),index+units(row)));
  } else {
    // Completed/removed requests no longer consume a purchased position.
    if(previous.some(id=>!present.has(id))) {
      const remaining=[...baseline.entries()].filter(([id])=>present.has(id)).sort((a,b)=>a[1]-b[1] || previous.indexOf(a[0])-previous.indexOf(b[0]));
      remaining.forEach(([id],index)=>baseline.set(id,index));
    }
    let last=Math.max(-1,...[...baseline.entries()].filter(([id])=>present.has(id)).map(([,value])=>value));
    queue.forEach(row=>{if(!baseline.has(key(row)))baseline.set(key(row),++last+units(row));});
  }
  const rows=queue.map(row=>row.id===target.id ? {...row,promotion} : row);
  const original=new Map(keys.map((id,index)=>[id,index]));
  rows.sort((a,b)=>(baseline.get(key(a))-units(a))-(baseline.get(key(b))-units(b)) || Number(units(b)>0)-Number(units(a)>0) || original.get(key(a))-original.get(key(b)));
  return {rows, baseline:rows.map(row=>[key(row),baseline.get(key(row))]), priority:rows.some(row=>units(row)>0) ? {baseline:rows.map(row=>[key(row),baseline.get(key(row))]),applied:rows.map(key)} : {}};
}

export function summarizeFunding(active, refunds, target, at) {
  const points=active.reduce((sum,row)=>sum+row.points,0);
  const payers=new Set(active.map(row=>row.login));
  const refundedPoints=refunds.filter(row=>row.state==='refunded').reduce((sum,row)=>sum+row.points,0);
  const refundPending=refunds.filter(row=>['refund_ready','refunding','refund_unknown'].includes(row.state)).reduce((sum,row)=>sum+row.points,0);
  return {version:2,state:points>0 ? 'active' : refundPending>0 ? 'refunding' : 'refunded',points,refundedPoints,refundPending,contributorCount:payers.size,
    paidBy:payers.size===1 ? [...payers][0] : '',requestTimestamp:Number(target.timestamp || 0),at};
}

// An estimate for this queue snapshot. The purchase still confirms the actual rank.
export function promotionQuotes(queue, saved = {}) {
  const quotes=new Map();if(!queue.length)return quotes;
  const normalized=applyPromotionOrder(queue,queue[0],queue[0].promotion,saved);
  const baseline=new Map(normalized.baseline);
  const candidates=queue.map((row,index)=>({row,index,score:baseline.get(key(row))-units(row),paid:units(row)>0})).sort((a,b)=>a.score-b.score || Number(b.paid)-Number(a.paid) || a.index-b.index);
  queue.forEach((row,index)=>{
    if(index===0){quotes.set(row.id,{points:0,position:1,command:''});return;}
    const other=candidates[0].row.id===row.id ? candidates[1] : candidates[0];
    const score=baseline.get(key(row))-units(row);
    const tiedPaid=other.paid && other.index<index;
    const places=Math.max(1,Math.ceil(score-other.score)+(tiedPaid && Number.isInteger(score-other.score) ? 1 : 0));
    const points=places*PROMOTION_RATE;
    if(!Number.isSafeInteger(points) || points+units(row)*PROMOTION_RATE>2147483647){quotes.set(row.id,null);return;}
    quotes.set(row.id,{points,position:index+1,command:'!qpromote '+(index+1)+' '+points});
  });return quotes;
}
