import React, {useEffect, useState} from 'react';
import {promotionLabel} from '../promotion.js';

type Quote={points:number;position:number;command:string};
type Contributor={login:string;activePoints:number;refundedPoints:number;pendingRefundPoints:number};
type PromotionVideo={id:string;title?:string;timestamp?:number;status?:string;promotionLabel?:string;promotion?:Record<string,unknown>};
type Details={contributors:Contributor[];totalContributors:number;nextOffset:number|null};

export default function PromotionDetails({video,quote,staff=false}:{video:PromotionVideo;quote?:Quote|null;staff?:boolean}) {
  const [open,setOpen]=useState(false),[data,setData]=useState<Details|null>(null),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[offset,setOffset]=useState(0);
  const label=video.promotionLabel || promotionLabel(video);
  const stamp=String(video.promotion?.at || label);
  useEffect(()=>{setData(null);setOffset(0);setMessage('');},[video.id,video.timestamp,stamp]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setMessage('');
    const query=new URLSearchParams({action:staff?'store':'queue-view',view:'promotion',id:String(video.id),timestamp:String(video.timestamp || 0),offset:String(offset)});
    fetch('/api/twitch/session?'+query,{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(async response=>{if(!response.ok)throw Error('Promotion details could not be loaded.');return response.json();})
      .then(body=>{if(!Array.isArray(body.contributors))throw Error('Promotion details could not be loaded.');setData(previous=>({...body,contributors:offset>0?[...(previous?.contributors || []),...body.contributors]:body.contributors}));})
      .catch(error=>{if(error.name!=='AbortError')setMessage(error.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[open,video.id,video.timestamp,stamp,offset,staff]);
  const copy=async()=>{
    if(!quote?.command)return;
    try{await navigator.clipboard.writeText(quote.command);setMessage('Command copied. Paste it in Twitch chat.');}
    catch{setMessage('Copy the displayed command into Twitch chat.');}
  };
  return <div className="promotion-details w-full min-w-0 space-y-1 text-[11px] text-amber-100/90" onClick={event=>event.stopPropagation()}>
    {quote && <p className="break-words">{quote.points===0?'Already next up.':<>Estimated next up: <strong>{quote.points.toLocaleString('en-US')} points</strong>. <code className="break-all">{quote.command}</code> <button type="button" onClick={()=>void copy()} className="rounded border border-amber-300/30 px-1.5 py-0.5" aria-label={'Copy promotion command for '+video.title}>Copy</button></>}</p>}
    <details onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer break-words rounded border border-amber-400/30 px-2 py-1 font-bold">{label || 'Promotion details'}</summary>
      <div className="mt-2 space-y-2 rounded border border-amber-400/20 bg-black/30 p-2">
        {quote?.points>0 && <p>Estimate for the current queue. Positions and the cost to reach next up can change before your command arrives.</p>}
        {loading && <p>Loading contributions…</p>}
        {data && <><p>{data.totalContributors} contributor{data.totalContributors===1?'':'s'}</p><ul className="space-y-1">{data.contributors.map(payer=><li className="break-words" key={payer.login}>@{payer.login}: {payer.activePoints.toLocaleString('en-US')} active points{payer.refundedPoints>0?' · '+payer.refundedPoints.toLocaleString('en-US')+' refunded':''}{payer.pendingRefundPoints>0?' · '+payer.pendingRefundPoints.toLocaleString('en-US')+' refund pending':''}</li>)}</ul>{data.nextOffset!==null && <button type="button" disabled={loading} onClick={()=>setOffset(data.nextOffset ?? 0)} className="rounded border border-amber-300/30 px-2 py-1">More contributors</button>}</>}
        <p>Promoted positions are protected from shuffles. Only a payer can withdraw their contributions before playback: <code>!unpromote [current queue position]</code>.</p>
      </div>
    </details>
    <p aria-live="polite">{message}</p>
  </div>;
}
