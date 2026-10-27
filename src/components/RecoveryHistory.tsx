import React, { useEffect, useState } from 'react';
export default function RecoveryHistory({ onRestored, label="Moderator recovery history" }) {
  const [data, setData] = useState({ snapshots: [], actions: [] });
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState('');
  const load = async () => {
    try {
      const response = await fetch('/api/twitch/session?action=store&view=recovery', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Error('Recovery history is unavailable.');
      setData(await response.json());
    } catch (error) { setMessage(error.message); }
  };
  useEffect(() => { void load(); }, []);
  const restore = async snapshot => {
    if (busy || !window.confirm('Undo this change for requests that have not changed since? Current playback and new requests will be preserved.')) return;
    setBusy(snapshot.id); setMessage('');
    try {
      const response = await fetch('/api/twitch/session?action=store', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'undo-snapshot', id: snapshot.id, confirmation: 'RESTORE' }) });
      const result = await response.json();
      if (!response.ok) throw Error('This change could not be restored.');
      setMessage(`Restored ${result.restored}; left ${result.skipped} requests unchanged because they changed later.`);
      await onRestored(); await load();
    } catch (error) { setMessage(error.message); } finally { setBusy(''); }
  };
  return <section className="rounded-xl border border-slate-700 p-3 space-y-3" aria-label={label}>
    <div className="flex items-center justify-between"><h4 className="font-bold text-slate-100">Recovery history</h4><button type="button" onClick={() => void load()} className="text-xs text-cyan-300">Refresh recovery history</button></div>
    <p className="text-xs text-slate-400">The last 12 queue changes are saved. Restore only affected requests and positions; playback and new arrivals remain intact.</p>
    {message && <p role="status" className="text-xs text-amber-200">{message}</p>}
    <ul className="max-h-56 overflow-y-auto space-y-2">{data.snapshots.map(snapshot => <li key={snapshot.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950 p-2 text-xs">
      <div><p className="font-bold text-slate-100">{snapshot.action} · {snapshot.affected} requests</p><p className="text-slate-400">{new Date(snapshot.at).toLocaleString()} · {snapshot.actor}</p></div>
      <button type="button" disabled={Boolean(busy) || Boolean(snapshot.restoredAt)} onClick={() => void restore(snapshot)} className="rounded-lg border border-cyan-700 px-3 py-2 text-cyan-200 disabled:opacity-40">{snapshot.restoredAt ? 'Restored' : 'Undo change'}</button>
    </li>)}</ul>
    {!data.snapshots.length && <p className="text-xs text-slate-400">No queue changes saved yet.</p>}
    <details className="text-xs text-slate-400"><summary>Recent queue action log</summary><ol className="mt-2 space-y-1">{data.actions.slice(0, 20).map(action => <li key={action.id}>{new Date(action.at).toLocaleString()} · {action.actor} · {action.action}</li>)}</ol></details>
  </section>;
}
