import React, { useEffect, useState } from 'react';

type Purchase = {id: string; login: string; title: string; points: number; state: string; code?: string};
type Diagnostics = {configured: boolean; purchases: Purchase[]};
// Mounted only for paim_beach_pete; the API independently enforces that identity.
export default function PointsDiagnostics() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Diagnostics | null>(null);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/twitch/session?action=store&view=points', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async response => { if (!response.ok) throw Error('Points diagnostics unavailable.'); return response.json(); })
      .then(setData).catch(error => { if (error.name !== 'AbortError') setMessage(error.message); });
    return () => controller.abort();
  }, [open]);
  const verify = async () => {
    setChecking(true);
    try {
      const response = await fetch('/api/twitch/session?action=store&view=points&verify=1', {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw Error('Could not check StreamElements authorization.');
      const result = await response.json();
      setMessage(result.ok ? 'JWT verified for 2o3a. No points were changed.' : 'Connection check failed: ' + result.code);
    } catch { setMessage('Could not check StreamElements authorization.'); }
    finally { setChecking(false); }
  };
  return <section className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs text-slate-300">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>StreamElements points diagnostics</button>
    {open && <div className="mt-3 space-y-2">
      <p>{data ? data.configured ? 'Server credential configured. Authorization is checked when a points command runs.' : 'STREAMELEMENTS_JWT is missing from this deployment.' : 'Loading…'}</p>
      <button type="button" disabled={checking} onClick={() => void verify()} className="rounded border border-slate-600 px-2 py-1 disabled:opacity-50">{checking ? 'Checking…' : 'Check connection (read-only)'}</button>
      <p aria-live="polite">{message}</p>
      <p>Unknown charge/refund results require manual verification in StreamElements. They are never retried automatically.</p>
      <ul className="max-h-64 space-y-2 overflow-auto">{data?.purchases?.map(purchase => <li key={purchase.id} className="break-words border-t border-slate-800 pt-2">
        @{purchase.login} · {purchase.title} · {purchase.points} points · {purchase.state}{purchase.code ? ' · ' + purchase.code : ''}<br />{purchase.id}
      </li>)}</ul>
    </div>}
  </section>;
}
