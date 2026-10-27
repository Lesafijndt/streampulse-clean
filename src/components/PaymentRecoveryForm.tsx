import React, {useState} from 'react';

export default function PaymentRecoveryForm({purchase,onResolved}:{purchase:{id:string;state:string;at:number;login:string;points:number};onResolved:()=>Promise<void>}) {
  const [resolution,setResolution]=useState(''),[confirmation,setConfirmation]=useState(''),[evidence,setEvidence]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const uncertain=purchase.state==='charge_unknown' || purchase.state==='refund_unknown';
  const resumable=['charged','refund_ready','refund_acknowledged','charging','refunding'].includes(purchase.state);
  if(!uncertain && !resumable)return null;
  const choices=purchase.state==='charge_unknown' ? {charge_confirmed:'I verified that the points were deducted',charge_absent:'I verified that no points were deducted'} : {refund_confirmed:'I verified that the points were refunded',refund_absent:'I verified that no refund was received'};
  const required=uncertain?'VERIFIED':'RESUME';
  const submit=async()=>{
    if(busy)return;setBusy(true);setMessage('');
    try{
      const response=await fetch('/api/twitch/session?action=store',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'recover-points',id:purchase.id,expectedState:purchase.state,expectedAt:purchase.at,resolution:uncertain?resolution:'resume',confirmation,evidence}),signal:AbortSignal.timeout(20000)});
      const result=await response.json();
      if(!response.ok)throw Error(response.status===409?'The payment changed or is still running. Refresh before reviewing it.':'Recovery did not finish. Refresh to check its current state before retrying.');
      setMessage('Payment state: '+result.state);setConfirmation('');setEvidence('');
    }catch(error){setMessage(error.message || 'Recovery could not be completed.');}
    finally{setBusy(false);await onResolved();}
  };
  return <details className="mt-2 rounded border border-amber-500/40 p-2">
    <summary className="cursor-pointer font-bold text-amber-200">Review payment recovery</summary>
    <div className="mt-2 space-y-2">
      <p>@{purchase.login} · {purchase.points} points. Verify the outcome in StreamElements first. A confirmed charge is fulfilled or refunded if the request can no longer be promoted. A confirmed missing refund will be issued once.</p>
      {uncertain && <><label className="block">Verified outcome<select aria-label={'Verified payment outcome '+purchase.id} value={resolution} onChange={event=>setResolution(event.target.value)} className="mt-1 w-full rounded bg-slate-900 p-2"><option value="">Choose a verified outcome</option>{Object.entries(choices).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="block">Verification note (no tokens or passwords)<input aria-label={'Payment verification note '+purchase.id} maxLength={240} value={evidence} onChange={event=>setEvidence(event.target.value)} className="mt-1 w-full rounded bg-slate-900 p-2" /></label></>}
      <label className="block">Type {required} to continue<input aria-label={'Payment recovery confirmation '+purchase.id} value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off" className="mt-1 w-full rounded bg-slate-900 p-2" /></label>
      <button type="button" onClick={()=>void submit()} disabled={busy || confirmation!==required || (uncertain && (!resolution || evidence.trim().length<8))} className="rounded border border-amber-500/50 px-2 py-1 text-amber-100 disabled:opacity-40">{busy?'Recovering…':'Apply verified recovery'}</button>
      <p aria-live="polite">{message}</p>
    </div>
  </details>;
}
