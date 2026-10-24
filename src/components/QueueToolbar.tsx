import React from 'react';
import { Bookmark, CheckCircle2, ListVideo, Search, Sparkles, X } from 'lucide-react';

export default function QueueToolbar({
  activeTab,
  setActiveTab,
  counts,
  setMediaTypeFilter,
  sortBy,
  setSortBy,
  selectedCategory,
  setSelectedCategory,
  categoryMeta,
  categoryCounts,
  searchQuery,
  setSearchQuery
}) {
  return (
    <>
                  {/* Nav Tabs */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {[
                        { id: 'queue', label: 'Active Queue', icon: ListVideo, count: counts.queue, badge: 'bg-purple-500/20 text-purple-300' },
                        { id: 'watch_later', label: 'Watch Later', icon: Bookmark, count: counts.watch_later, badge: 'bg-cyan-500/20 text-cyan-300' },
                        { id: 'watched', label: 'History', icon: CheckCircle2, count: counts.watched, badge: 'bg-emerald-500/20 text-emerald-300' }
                      ].map((tab) => {
                        const Icon = tab.icon;
                        const active = activeTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            onClick={() => { setActiveTab(tab.id); if (tab.id !== 'queue') setMediaTypeFilter('All'); }}
                            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all ${
                              active
                                ? 'gachi-control-btn-primary'
                                : 'gachi-control-btn'
                            }`}
                          >
                            <Icon className="w-4 h-4" />
                            <span>{tab.label}</span>
                            <span className={`gachi-counter-badge ${active ? 'gachi-counter-badge-active' : ''}`}>
                              {tab.count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
      
                    {/* Sorter */}
                    <select
                      value={activeTab === 'queue' ? 'priority' : activeTab === 'watched' && sortBy === 'priority' ? 'played' : sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      disabled={activeTab === 'queue'}
                      title={activeTab === 'queue' ? 'Queue order follows pinned priority, then votes, then request time' : 'Sort this non-queue list'}
                      className="gachi-select rounded-xl px-3 py-1.5 text-xs disabled:opacity-70"
                    >
                      <option value="priority">Sort: Playback priority</option>
                      <option value="played">Sort: Recently Played</option>
                      <option value="upvotes">Sort: Most Hype (Votes)</option>
                      <option value="newest">Sort: Recently Added</option>
                    </select>
                  </div>
      
                  {/* Category Filter Pills & Search */}
                  <div className="gachi-filter-toolbar flex flex-col items-stretch gap-2.5">
                    {/* Category Pills */}
                    <div className="gachi-category-filter flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => { setSelectedCategory('All'); setMediaTypeFilter('All'); }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                          selectedCategory === 'All'
                            ? 'gachi-control-btn-primary'
                            : 'gachi-control-btn'
                        }`}
                      >
                        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        <span>All Categories</span>
                        <span className="gachi-category-count">{categoryCounts.All || 0}</span>
                      </button>
      
                      {Object.entries(categoryMeta).map(([catKey, catData]) => {
                        const Icon = catData.icon;
                        const active = selectedCategory === catKey;
                        return (
                          <button
                            key={catKey}
                            onClick={() => { setSelectedCategory(catKey); setMediaTypeFilter('All'); }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all border ${
                              active
                                ? 'gachi-control-btn-primary'
                                : 'gachi-control-btn'
                            }`}
                          >
                            <Icon className="w-3.5 h-3.5" style={{ color: catData.colorHex }} />
                            <span>{catData.label}</span>
                              <span className="gachi-category-count">{categoryCounts[catKey] || 0}</span>
                          </button>
                        );
                      })}
                    </div>
      
                    {/* Search */}
                    <div className="gachi-category-search relative w-full min-w-0">
                      <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search title or @requester..."
                        className="gachi-input w-full rounded-xl pl-9 pr-7 py-1.5 text-xs"
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery('')}
                          className="gachi-inline-icon-btn absolute right-2.5 top-1/2 -translate-y-1/2"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
    </>
  );
}
