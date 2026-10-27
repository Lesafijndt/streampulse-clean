import React, {useEffect, useState} from 'react';
import {getPlaybackGeneration} from '../playerBridge.js';

export default function PlaybackIssueReporter({video, intent, volume, muted, providerCode}) {
  const [open,setOpen]=useState(false),[issue,setIssue]=useState('other'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[reports,setReports]=useState([]);
  const generation=getPlaybackGeneration(video);
  useEffect(()=>{setMessage('');setIssue('other');},[generation]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    fetch('/api/twitch/session?action=store&view=playback-reports',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(async response=>{if(!response.ok)throw Error('Reports could not be loaded.');return response.json();})
      .then(body=>setReports(Array.isArray(body.reports) ? body.reports : [])).catch(error=>{if(error.name!=='AbortError')setMessage(error.message);});
    return()=>controller.abort();
  },[open]);
  const submit=async()=>{
    if(busy||!video)return;
    setBusy(true);setMessage('');
    try{
      const response=await fetch('/api/twitch/session?action=store',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({operation:'report-playback',id:video.id,generation,issue,providerCode,seconds:intent?.seconds,paused:intent?.paused,volume,muted}),signal:AbortSignal.timeout(12000)});
      const body=await response.json().catch(()=>({}));
      if(!response.ok || body.ok!==true || !body.report)throw Error(body.code==='report_recently_saved'?'A report for this video was saved in the last minute.':response.status===409?'The playing video changed. Check it and try again.':'Report could not be saved.');
      setReports(previous=>[body.report,...previous].slice(0,100));setMessage('Playback issue saved.');
    }catch(error){setMessage(error.message || 'Report could not be saved.');}finally{setBusy(false);}
  };
  return <div className="relative text-xs">
    <button type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} className="rounded-lg border border-slate-600 px-3 py-2 text-slate-300">Report playback issue</button>
    {open&&<section aria-label="Private playback reports" className="absolute right-0 z-40 mt-2 w-72 max-w-[85vw] space-y-3 rounded-xl border border-slate-600 bg-slate-950 p-4 text-slate-200 shadow-xl">
      <label className="block">What went wrong?<select aria-label="Playback issue type" value={issue} onChange={event=>setIssue(event.target.value)} className="mt-2 w-full rounded border border-slate-600 bg-slate-900 p-2">
        {Object.entries({start:'Video will not start',stutter:'Lag or stuttering',controls:'Pause or controls',completion:'Did not advance at the end',audio:'Volume or mute',black_screen:'Black screen',other:'Other playback issue'}).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="button" disabled={busy||!video} onClick={()=>void submit()} className="rounded-lg bg-purple-700 px-3 py-2 disabled:opacity-50">{busy?'Saving…':'Save playback report'}</button>
      <p aria-live="polite">{message}</p>
      <p className="text-slate-400">Records this video and player settings. Only paim_beach_pete can view reports.</p>
      <details><summary>Recent reports ({reports.length})</summary><ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">{reports.slice(0,20).map(report=><li key={report.at}>{report.title} · {report.platform} · {report.issue} · {new Date(report.at).toLocaleString()}</li>)}</ul></details>
    </section>}
  </div>;
}
