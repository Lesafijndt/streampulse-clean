import {randomUUID} from 'node:crypto';
import {processPromotion} from './queue-promotion.js';

const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const confirmedTransitions={charge_confirmed:['charge_unknown','charged'],charge_absent:['charge_unknown','failed'],refund_confirmed:['refund_unknown','refund_acknowledged'],refund_absent:['refund_unknown','refund_ready']};

// This endpoint records an operator's independently verified result. It never
// guesses whether an ambiguous external write succeeded or blindly repeats it.
export async function recoverPointsPayment(db,prefix,identity,body,dependencies={}) {
  if(identity?.login!=='paim_beach_pete')throw fail('moderator_required',403);
  if(!/^[A-Za-z0-9_-]{1,180}$/.test(body.id || '') || !Number.isFinite(body.expectedAt) || typeof body.expectedState!=='string')throw fail('invalid_payment_recovery');
  const resume=body.resolution==='resume';
  if(body.confirmation!==(resume?'RESUME':'VERIFIED') || (!resume && (typeof body.evidence!=='string' || body.evidence.trim().length<8 || body.evidence.length>240)))throw fail('payment_verification_required');
  const now=dependencies.now || Date.now,ref=db.doc(prefix+'point_purchases/'+body.id);
  const purchase=await db.runTransaction(async tx=>{
    const current=(await tx.get(ref)).data();
    if(!current || current.state!==body.expectedState || Number(current.updatedAt || current.createdAt)!==body.expectedAt)throw fail('payment_state_changed',409);
    let state;
    if(resume) {
      if(!['charged','refund_ready','refund_acknowledged','charging','refunding'].includes(current.state))throw fail('payment_not_resumable',409);
      if(['charging','refunding'].includes(current.state) && now()-Number(current.updatedAt || current.createdAt)<60000)throw fail('payment_still_running',409);
      state=current.state;
    } else {
      const transition=confirmedTransitions[body.resolution];
      if(!transition || transition[0]!==current.state)throw fail('invalid_payment_resolution',409);
      state=transition[1];
    }
    const auditId='recovery-'+randomUUID();
    tx.create(db.doc(prefix+'points_reconciliations/'+auditId),{id:auditId,purchaseId:body.id,actor:identity.login,from:current.state,to:state,resolution:body.resolution,evidence:resume?'Resume acknowledged payment':body.evidence.trim(),at:now()});
    tx.update(ref,{state,reconciledBy:identity.login,reconciledAt:now(),...(resume?{}:{updatedAt:now(),code:'operator_verified'})});
    return {...current,state};
  });
  if(purchase.state!=='failed') {
    await processPromotion(db,prefix,{login:purchase.login,type:purchase.kind==='refund' || purchase.originalPurchaseId || purchase.originalPurchaseIds ? 'unpromote':'promote'},body.id,undefined,{...dependencies,resumePayment:true});
  }
  const updated=(await ref.get()).data();
  return {ok:true,state:updated.state};
}
