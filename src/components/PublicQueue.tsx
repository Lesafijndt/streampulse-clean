import React, { useEffect, useState } from 'react';
import { ListVideo, RefreshCw, Search } from 'lucide-react';
import { formatMediaDuration } from '../queueLogic.js';

type QueueItem = { position: number; id: string; title: string; url: string; platform: string; durationSec: number | null; requestedBy: string };
type QueueView = { queue: QueueItem[]; playing: QueueItem | null; updatedAt: string | number | null };

export default function PublicQueue() {
  const [data, setData] = useState<QueueView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (document.hidden || pending) return;
      pending = true;
      controller = new AbortController();
      setLoading(true);
      try {
        const response = await fetch('/api/twitch/session?action=queue-view', { cache: 'no-store', signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || `Queue unavailable (${response.status}).`);
        if (!body || !Array.isArray(body.queue)) throw new Error('The queue response could not be loaded.');
        if (active) { setData(body); setError(''); }
      } catch (failure) {
        if (active && failure.name !== 'AbortError') setError(failure.message || 'Could not load the queue. Please try again.');
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    const visibility = () => {
      if (document.hidden) controller?.abort();
      else void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [refreshKey]);

  const query = search.trim().toLowerCase();
  const queue = [...(data?.queue || [])].sort((a, b) => a.position - b.position);
  const visible = queue.filter((item) => `${item.title} ${item.requestedBy} ${item.platform}`.toLowerCase().includes(query));
  const details = (item: QueueItem) => (
    <div className="min-w-0">
      <p className="break-words font-semibold text-rose-50">{item.title || 'Untitled request'}</p>
      <p className="mt-1 text-sm text-rose-200/70">{formatMediaDuration(item.durationSec) || 'Duration unknown'} · {item.platform || 'Media'} · Requested by {item.requestedBy || 'Viewer'}</p>
    </div>
  );

  return (
    <main className="min-h-screen bg-[#090308] px-4 py-10 text-rose-50 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div><h1 className="flex items-center gap-3 text-3xl font-bold"><ListVideo aria-hidden="true" /> Stream queue</h1><p className="mt-2 text-sm text-rose-200/70">See what’s playing and what’s coming up. Updates every 30 seconds.</p></div>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading} className="rounded-xl border border-rose-900 bg-[#260b19] p-3 disabled:opacity-50" aria-label="Refresh queue"><RefreshCw aria-hidden="true" className={loading ? 'h-5 w-5 animate-spin' : 'h-5 w-5'} /></button>
        </header>
        <img src="/images/cowboys-pasture.png" alt="Adult cowboys at a ranch at sunset" loading="lazy" className="max-h-64 w-full rounded-2xl object-contain" />
        {error && <p role="alert" className="rounded-xl border border-rose-800 bg-rose-950/50 p-4">{error}{data && ' Showing the last loaded queue.'}</p>}
        <section aria-labelledby="now-playing" className="rounded-2xl border border-rose-900/70 bg-[#210914] p-5"><h2 id="now-playing" className="mb-3 text-sm font-bold uppercase tracking-widest text-rose-300">Now playing</h2>{data?.playing ? details(data.playing) : <p className="text-rose-200/70">{!data && loading ? 'Loading queue…' : 'Nothing playing right now.'}</p>}</section>
        <section aria-labelledby="waiting-heading">
          <h2 id="waiting-heading" className="mb-4 text-xl font-bold">Coming up <span className="text-rose-300">({queue.length})</span></h2>
          <label className="mb-4 flex items-center gap-2 rounded-xl border border-rose-900 bg-[#190710] px-4"><Search className="h-4 w-4 text-rose-300" aria-hidden="true" /><span className="sr-only">Search queue</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles or requesters" className="w-full bg-transparent py-3 outline-none" type="search" /></label>
          <ol className="space-y-3">{visible.map((item) => <li key={item.id} className="flex gap-4 rounded-xl border border-rose-900/50 bg-[#190710] p-4"><span className="min-w-8 text-lg font-bold text-rose-300" aria-label={`Position ${item.position}`}>{item.position}</span>{details(item)}</li>)}</ol>
          {data && visible.length === 0 && <p className="py-6 text-center text-rose-200/70">{query ? 'No requests match your search.' : 'The waiting queue is empty.'}</p>}
        </section>
      </div>
    </main>
  );
}
