import React, { useMemo, useState } from 'react';
import { Activity, BarChart3, CheckCircle2, ChevronDown, ListVideo, RefreshCw, Timer, TrendingUp, Users, ThumbsUp, SkipForward } from 'lucide-react';
import ConnectionStatusPill from './ConnectionStatusPill';
import { buildActivityStatistics, filterActivityEventsByPeriod } from '../activityLog.js';

function Metric({ icon: Icon, label, value, detail }) {
  return <div className="gachi-stat-card min-w-0 rounded-xl border p-2.5">
    <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400"><Icon className="h-3 w-3 shrink-0" /><span>{label}</span></div>
    <div className="mt-1.5 text-xl font-black leading-none tabular-nums text-white">{value}</div>
    <div className="mt-1 text-[9px] leading-4 text-slate-500">{detail}</div>
  </div>;
}


export default function StatsBoard({
  queueStats, activityEvents = [], currentSessionId = '', statsNow = Date.now(), statsExpanded, onToggle, onRefreshStats,
  activitySyncStatus, activitySyncTone, activitySyncError, canRetryActivitySync,
  onRetryActivitySync, networkOnline
}) {
  const [statsPeriod, setStatsPeriod] = useState('lifetime');
  const activityStats = useMemo(() => buildActivityStatistics(filterActivityEventsByPeriod(activityEvents, {
    period: statsPeriod,
    sessionId: currentSessionId,
    now: statsNow
  })), [activityEvents, statsPeriod, currentSessionId, statsNow]);
  const periodLabel = statsPeriod === '24h' ? 'Last 24 hours' : statsPeriod === 'session' ? 'This tab session' : 'Lifetime';
  const runwayMinutes = Math.ceil(Math.max(0, Number(queueStats.queueDurationSeconds) || 0) / 60);
  const runway = `${Math.floor(runwayMinutes / 60)}h ${runwayMinutes % 60}m`;
  return <section className="gachi-panel gachi-stats-panel rounded-2xl border p-3 space-y-3">
    <div className="flex items-center justify-between gap-2">
      <button type="button" onClick={onToggle} aria-expanded={statsExpanded} className="flex min-w-0 items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-slate-100 hover:text-white">
        <BarChart3 className="h-4 w-4 text-amber-200" /> Stats & analytics
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${statsExpanded ? 'rotate-180' : ''}`} />
      </button>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onRefreshStats}
          className="gachi-control-btn inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-[9px] font-bold"
          title="Refresh saved activity and pull the latest cloud event log"
          aria-label="Refresh stats"
        >
          <RefreshCw className="h-3 w-3" />
          <span className="hidden xl:inline">Refresh</span>
        </button>
        <ConnectionStatusPill tone={activitySyncTone}><Activity className="h-3 w-3" />{activitySyncStatus}</ConnectionStatusPill>
      </div>
    </div>
    {statsExpanded && <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="stats-period" className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Activity window</label>
          <select id="stats-period" className="gachi-select rounded-lg px-2 py-1 text-[10px]" value={statsPeriod} onChange={(event) => setStatsPeriod(event.target.value)}>
            <option value="lifetime">Lifetime</option>
            <option value="24h">Last 24 hours</option>
            <option value="session">This tab session</option>
          </select>
        </div>
        <span className="text-[9px] text-slate-500">{networkOnline ? 'Network online' : 'Offline · local changes saved'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric icon={Users} label="People" value={activityStats.uniqueRequesters} detail="unique requesters · selected window" />
        <Metric icon={TrendingUp} label="Requests" value={activityStats.totalRequests} detail={periodLabel.toLowerCase() + ' request events'} />
        <Metric icon={ListVideo} label="Waiting" value={queueStats.queueCount} detail="live queue · not period-filtered" />
        <Metric icon={CheckCircle2} label="Completed" value={activityStats.completed} detail="player ended events" />
        <Metric icon={SkipForward} label="Skipped" value={activityStats.skipped} detail="tracks skipped manually" />
        <Metric icon={ThumbsUp} label="Votes" value={activityStats.votes} detail="successful upvotes" />
      </div>
      <div className="gachi-inset-card flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5">
        <div className="min-w-0"><div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Queue runway</div><div className="mt-1 text-sm font-black text-white">{runway} <span className="text-[9px] font-semibold text-slate-500">approx.</span></div><div className="mt-1 text-[9px] leading-4 text-slate-500">{queueStats.queueKnownCount} known lengths · {queueStats.queueEstimatedCount} estimated</div></div>
        <Timer className="h-4 w-4 shrink-0 text-amber-200" />
      </div>

      <div className="gachi-inset-card rounded-xl border p-3">
        <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Top 10 requesters</span><span className="text-[9px] text-slate-500">{activityStats.removed} requests removed</span></div>
        {activityStats.requesters.length ? <div className="space-y-1.5">{activityStats.requesters.slice(0, 10).map((item, index) => <div key={item.label} className="flex items-center justify-between gap-2 text-[10px]"><span className="min-w-0 truncate text-slate-200">{index + 1}. @{item.label}</span><span className="font-mono font-bold text-amber-100">{item.count}</span></div>)}</div> : <p className="text-[10px] text-slate-600">No requester data recorded yet</p>}
      </div>
      {activitySyncError && canRetryActivitySync && <button type="button" onClick={onRetryActivitySync} className="gachi-control-btn flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[10px] font-bold"><RefreshCw className="h-3.5 w-3.5" /> Retry activity sync</button>}
      <div className="text-[9px] leading-4 text-slate-500">{periodLabel} filters recorded requests, people, completion, skips, votes, and rankings. Waiting count and queue runway always describe the current queue. Events are recorded as they happen; legacy queue/history items may be imported when available, and completion is counted only when the player reports an ended event.</div>
    </div>}
  </section>;
}
