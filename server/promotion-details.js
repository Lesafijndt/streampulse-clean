const fail=(code,status=400)=>Object.assign(Error(code),{code,status});

export async function readPromotionDetails(db,prefix,{id,timestamp,offset=0},allowHistory=false) {
  if(!/^[A-Za-z0-9_-]{1,180}$/.test(id || '') || !Number.isFinite(Number(timestamp)) || !Number.isInteger(Number(offset)) || Number(offset)<0 || Number(offset)>1000000)throw fail('invalid_promotion_request');
  // A transaction keeps contributor totals and request identity from different
  // generations from being mixed during a replay or incoming duplicate request.
  return db.runTransaction(async tx=>{
    const video=(await tx.get(db.doc(prefix+'queue_videos/'+id))).data();
    if(!video || video.channelRoom!=='2o3a' || Number(video.timestamp || 0)!==Number(timestamp) || !(allowHistory?['queue','playing','watched','watch_later']:['queue','playing']).includes(video.status))throw fail('promotion_not_found',404);
    const records=await tx.get(db.collection(prefix+'point_purchases').where('videoId','==',id).where('timestamp','==',Number(timestamp)));
    const byPayer=new Map();
    for(const doc of records.docs) {
      const row=doc.data();
      if(row.url!==video.url || !/^[a-z0-9_]{1,25}$/.test(row.login || '') || !Number.isSafeInteger(row.points) || row.points<=0)continue;
      const refund=row.kind==='refund' || row.originalPurchaseId || row.originalPurchaseIds;
      const active=!refund && row.state==='fulfilled' ? row.points : 0;
      const refunded=refund && row.state==='refunded' ? row.points : 0;
      const pending=refund && ['refund_ready','refunding','refund_unknown','refund_acknowledged'].includes(row.state) ? row.points : 0;
      if(!active && !refunded && !pending)continue;
      const payer=byPayer.get(row.login) || {login:row.login,activePoints:0,refundedPoints:0,pendingRefundPoints:0};
      payer.activePoints+=active;payer.refundedPoints+=refunded;payer.pendingRefundPoints+=pending;byPayer.set(row.login,payer);
    }
    const contributors=[...byPayer.values()].sort((a,b)=>b.activePoints-a.activePoints || a.login.localeCompare(b.login));
    return {id,timestamp:Number(timestamp),contributors:contributors.slice(Number(offset),Number(offset)+50),totalContributors:contributors.length,nextOffset:Number(offset)+50<contributors.length?Number(offset)+50:null,
      activePoints:contributors.reduce((sum,row)=>sum+row.activePoints,0),refundedPoints:contributors.reduce((sum,row)=>sum+row.refundedPoints,0),pendingRefundPoints:contributors.reduce((sum,row)=>sum+row.pendingRefundPoints,0)};
  });
}
