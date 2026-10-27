import React, { useEffect, useState } from 'react';
import { ListVideo, RefreshCw, Search } from 'lucide-react';
import { formatMediaDuration } from '../queueLogic.js';

type QueueItem = { promotionLabel?: string; position: number; id: string; title: string; url: string; platform: string; durationSec: number | null; requestedBy: string };
type QueueView = { queue: QueueItem[]; playing: QueueItem | null; updatedAt: string | number | null };

export default function PublicQueue() {
  const [data, setData] = useState<QueueView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [requester, setRequester] = useState(() => new URLSearchParams(location.search).get('requester') || '');
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
  const owner = requester.trim().replace(/^@/, '').toLowerCase();
  const visible = queue.filter(item => !owner || item.requestedBy.trim().replace(/^@/, '').toLowerCase() === owner).filter((item) => `${item.title} ${item.requestedBy} ${item.platform}`.toLowerCase().includes(query));
  const details = (item: QueueItem) => (
    <div className="min-w-0">
      <p className="break-words font-semibold text-rose-50">{item.title || 'Untitled request'}</p>
      {item.promotionLabel && <p className="mt-1 text-xs font-bold text-amber-200">{item.promotionLabel}</p>}
      <p className="mt-1 text-sm text-rose-200/70">{formatMediaDuration(item.durationSec) || 'Duration unknown'} · {item.platform || 'Media'} · Requested by {item.requestedBy || 'Viewer'}</p>
    </div>
  );

  return (
    <main className="min-h-screen bg-[#090308] px-4 py-10 text-rose-50 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="public-screening-banner">
          <img src="/images/ranch-party-v2.jpg" width="2172" height="724" alt="A lively adult cowboy ranch party with sunset mountains and warm barn lights" decoding="auto" fetchPriority="high" />
          <div className="public-screening-caption">
            <div className="min-w-0"><p className="mb-1 text-[10px] font-bold uppercase tracking-[.25em] text-amber-200">2o3a's screening room</p><h1 className="flex items-center gap-3 text-3xl font-bold"><ListVideo aria-hidden="true" /> Stream queue</h1><p className="mt-2 text-sm text-rose-100/80">{queue.length} waiting &middot; Read-only &middot; Updates every 30 seconds</p></div>
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading} className="shrink-0 rounded-xl border border-amber-200/30 bg-black/50 p-3 disabled:opacity-50" aria-label="Refresh queue"><RefreshCw aria-hidden="true" className={loading ? 'h-5 w-5 animate-spin' : 'h-5 w-5'} /></button>
          </div>
        </header>
        {error && <p role="alert" className="rounded-xl border border-rose-800 bg-rose-950/50 p-4">{error}{data && ' Showing the last loaded queue.'}</p>}
        <section aria-labelledby="now-playing" className="rounded-2xl border border-rose-900/70 bg-[#210914] p-5"><h2 id="now-playing" className="mb-3 text-sm font-bold uppercase tracking-widest text-rose-300">Now playing</h2>{data?.playing ? details(data.playing) : <p className="text-rose-200/70">{!data && loading ? 'Loading queue…' : 'Nothing playing right now.'}</p>}</section>
        <section aria-labelledby="waiting-heading">
          <p className="mb-3 text-sm text-amber-100/80">Move any waiting video to next up: !promote [queue position] in Twitch chat. 50 points per position crossed (for example, #10 to #1 costs 450). Cancel before playback with !unpromote [queue position] for a full refund to the payer.</p>
          <h2 id="waiting-heading" className="mb-4 text-xl font-bold">Coming up <span className="text-rose-300">({queue.length})</span></h2>
          <label className="mb-4 flex items-center gap-2 rounded-xl border border-rose-900 bg-[#190710] px-4"><Search className="h-4 w-4 text-rose-300" aria-hidden="true" /><span className="sr-only">Search queue</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles or requesters" className="w-full bg-transparent py-3 outline-none" type="search" /></label>
          <label className="mb-4 block text-sm text-rose-200">Find your requests<input aria-label="Requester Twitch username" value={requester} onChange={event => setRequester(event.target.value)} placeholder="Your Twitch username (exact match)" className="mt-2 w-full rounded-xl border border-rose-900 bg-[#190710] p-3" /></label>
          <p className="mb-3 text-sm text-rose-200/70" aria-live="polite">{visible.length} matching waiting request{visible.length === 1 ? '' : 's'}. Positions are in the full queue.{owner && data?.playing?.requestedBy?.replace(/^@/, '').toLowerCase() === owner ? ' Your request is playing now.' : ''}</p>
          <ol className="space-y-3">{visible.map((item) => <li key={item.id} className="flex gap-4 rounded-xl border border-rose-900/50 bg-[#190710] p-4"><span className="min-w-8 text-lg font-bold text-rose-300" aria-label={`Position ${item.position}`}>{item.position}</span>{details(item)}</li>)}</ol>
          {data && visible.length === 0 && <p className="py-6 text-center text-rose-200/70">{query || owner ? 'No requests match your search.' : 'The waiting queue is empty.'}</p>}
        </section>
      </div>
    </main>
  );
}
