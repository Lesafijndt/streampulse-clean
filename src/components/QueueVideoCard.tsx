import React from 'react';
import { CATEGORY_META, getVideoCategory, getVideoMediaType } from '../mediaUtils.js';
import { getDurationEstimate, getThumbnailDurationLabel } from '../queueLogic.js';

export default function QueueVideoCard({
  video,
  index,
  activeTab,
  currentVideo,
  queueRankById,
  isStaff,
  draggedQueueId,
  setDraggedQueueId,
  dragOverQueueId,
  setDragOverQueueId,
  handleDropReorder,
  handlePlayNow,
  handleCategoryChange,
  handleUpvote,
  twitchUsername,
  votedIds,
  normalizeTwitchLogin,
  syncDeleteVideo,
  handleMoveOrder,
  handleTogglePin,
  handleMoveToWatchLater,
  handleRequeue
}) {

                  const isCurrent = currentVideo && currentVideo.id === video.id;
                  const queueRank = queueRankById.get(String(video.id)) ?? (index + 1);
                  // Keep the queue rank visible for every row; only the first waiting item needs a badge.
                  const queuePositionLabel = activeTab === 'queue' && video.status === 'queue' && queueRank === 1
                    ? 'UP NEXT'
                    : '';
                  const resolvedCategory = getVideoCategory(video); const catObj = CATEGORY_META[resolvedCategory] || CATEGORY_META.General;

                  return (
                    <div
                      draggable={Boolean(isStaff && activeTab === 'queue' && video.status === 'queue')}
                      onDragStart={(event) => {
                        if (!isStaff || activeTab !== 'queue' || video.status !== 'queue') { event.preventDefault(); return; }
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', String(video.id));
                        setDraggedQueueId(String(video.id));
                      }}
                      onDragOver={(event) => {
                        if (!isStaff || activeTab !== 'queue' || video.status !== 'queue') return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        if (dragOverQueueId !== String(video.id)) setDragOverQueueId(String(video.id));
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget)) setDragOverQueueId((id) => id === String(video.id) ? '' : id);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const movingId = event.dataTransfer.getData('text/plain') || draggedQueueId;
                        handleDropReorder(movingId, video.id);
                        setDraggedQueueId('');
                        setDragOverQueueId('');
                      }}
                      onDragEnd={() => { setDraggedQueueId(''); setDragOverQueueId(''); }}
                      className={`gachi-queue-item group relative flex items-center justify-between gap-3 p-2.5 rounded-2xl border transition-all ${draggedQueueId === String(video.id) ? 'gachi-dragging' : ''} ${dragOverQueueId === String(video.id) && draggedQueueId !== String(video.id) ? 'gachi-drop-target' : ''} ${
                        isCurrent
                          ? 'bg-purple-950/20 border-purple-500/50 shadow-lg shadow-purple-950/40'
                          : video.pinned
                          ? 'bg-amber-950/15 border-amber-500/30'
                          : 'bg-[#131722] hover:bg-[#181d2a] border-slate-800/90'
                      }`}
                    >
                      {/* Left: Thumbnail + Metadata */}
                      <div className="flex items-start sm:items-center gap-3.5 min-w-0 flex-1 w-full">
                        {/* Order indicator */}
                        <div className="hidden sm:flex flex-col items-center justify-center w-7 text-center shrink-0">
                          {video.pinned ? (
                            <Pin className="w-4 h-4 text-amber-400 fill-current" />
                          ) : (
                            <span className="text-xs font-mono font-bold text-slate-500">#{queueRankById.get(String(video.id)) ?? (index + 1)}</span>
                          )}
                        </div>

                        {/* Thumbnail */}
                        <div
                          onClick={() => handlePlayNow(video)}
                          className="gachi-queue-thumbnail relative w-28 sm:w-36 h-20 rounded-xl overflow-hidden bg-slate-900 shrink-0 cursor-pointer border border-white/5"
                        >
                          <img
                            src={video.thumbnail}
                            alt=""
                            onError={(e) => {
                              e.target.src = 'https://placehold.co/640x360/18181b/a1a1aa?text=Yedi+Hub';
                            }}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                            <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg">
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            </div>
                          </div>
                          <span
                            className={`absolute bottom-1 right-1 px-1.5 py-0.2 rounded bg-black/85 text-[10px] font-mono font-bold text-slate-100 ${getDurationEstimate(video).estimated ? 'border border-amber-300/30 text-amber-100' : ''}`}
                            title={getDurationEstimate(video).estimated ? 'Approximate duration: the source has not exposed its actual length yet.' : 'Actual video duration'}
                            aria-label={getDurationEstimate(video).estimated ? 'Approximate duration ' + getThumbnailDurationLabel(video) : 'Video duration ' + getThumbnailDurationLabel(video)}
                          >
                            {getThumbnailDurationLabel(video)}
                          </span>
                        </div>

                        {/* Details */}
                        <div className="gachi-queue-details min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {/* Editable Category Dropdown for 1-Click Fixes */}
                            {isStaff ? (
                              <select
                                value={resolvedCategory}
                                onChange={(e) => handleCategoryChange(video.id, e.target.value)}
                                className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold border cursor-pointer focus:outline-none ${catObj.badgeBg}`}
                                title="Click to fix or change category"
                              >
                                {Object.keys(CATEGORY_META).map((cat) => (
                                  <option key={cat} value={cat} className="bg-[#141926] text-white">
                                    {cat}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold border ${catObj.badgeBg}`}>
                                {resolvedCategory}
                              </span>
                            )}

                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase border ${ getVideoMediaType(video) === 'Music' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-amber-500/15 text-amber-200 border-amber-500/40'}`}>
                              {getVideoMediaType(video)}
                            </span>
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-800 text-slate-300 uppercase">
                              {video.platform}
                            </span>
                            {queuePositionLabel && (
                              <span className="gachi-queue-position-badge px-1.5 py-0.5 rounded border bg-emerald-500/15 border-emerald-500/30 text-emerald-300">
                                {queuePositionLabel}
                              </span>
                            )}

                            {video.pinned && (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                Pinned Priority
                              </span>
                            )}
                          </div>

                          <h4
                            onClick={() => handlePlayNow(video)}
                            className="text-sm font-bold text-slate-100 hover:text-purple-300 cursor-pointer truncate"
                            title={video.title}
                          >
                            {video.title}
                          </h4>

                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
                            <span>
                              by <strong className="text-slate-200 font-semibold">@{video.requestedBy}</strong>
                            </span>
                            <span>•</span>
                            <span>{video.addedAt}</span>
                            {video.watchedAt && (
                              <>
                                <span>•</span>
                                <span className="text-emerald-400 font-medium">Played {video.watchedAt}</span>
                              </>
                            )}
                            {video.note && (
                              <>
                                <span>•</span>
                                <span className="text-slate-300 italic truncate max-w-xs">"{video.note}"</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: Arena Control Buttons */}
                      <div className="gachi-queue-actions flex flex-wrap items-center gap-1.5 self-end sm:self-center shrink-0">
                        {/* Hype Vote */}
                        <button
                          onClick={() => handleUpvote(video.id)}
                          disabled={normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchUsername) || (Array.isArray(video.voters) && video.voters.some((name) => normalizeTwitchLogin(name) === normalizeTwitchLogin(twitchUsername))) || Boolean(votedIds[`${normalizeTwitchLogin(twitchUsername)}:${video.id}`])}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                            (Array.isArray(video.voters) && video.voters.some((name) => normalizeTwitchLogin(name) === normalizeTwitchLogin(twitchUsername))) || votedIds[`${normalizeTwitchLogin(twitchUsername)}:${video.id}`]
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                              : 'bg-[#181e2e] hover:bg-slate-800 border-slate-700/80 text-slate-300'
                          }`}
                          title={normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchUsername) ? 'You cannot upvote your own request' : 'Upvote this video to move it higher in the queue'}
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                          <span>{video.upvotes || 0}</span>
                        </button>

                        {/* Every request is immediately playable; no approval state. */}
                        <>
                            {video.status === 'queue' && normalizeTwitchLogin(video.requestedBy) === normalizeTwitchLogin(twitchUsername) && (
                              <button
                                onClick={() => {
                                  if (window.confirm(`Remove your request "${String(video.title || 'this video').slice(0, 80)}" from the queue?`)) {
                                    void syncDeleteVideo(video.id);
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-rose-950/60 text-rose-300 border border-rose-500/20"
                                title="Remove your own waiting request"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handlePlayNow(video)}
                              className="gachi-queue-play-now px-2.5 py-1.5 rounded-xl bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/30 text-xs font-bold transition-colors"
                            >
                              Play Now
                            </button>

                            {isStaff && (
                              <>
                                {video.status === 'queue' && (
                                  <>
                                    <button
                                      onClick={() => handleMoveOrder(video.id, 'up')}
                                      className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-slate-300"
                                      title="Move Up"
                                    >
                                      <ArrowUp className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleMoveOrder(video.id, 'down')}
                                      className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-slate-300"
                                      title="Move Down"
                                    >
                                      <ArrowDown className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleTogglePin(video)}
                                      className={`p-1.5 rounded-lg border transition-colors ${
                                        video.pinned
                                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                          : 'bg-[#181e2e] border-transparent hover:bg-slate-700 text-slate-400'
                                      }`}
                                      title="Pin Priority"
                                    >
                                      <Pin className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}

                                {video.status !== 'watch_later' && (
                                  <button
                                    onClick={() => handleMoveToWatchLater(video)}
                                    className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-slate-700 text-cyan-400"
                                    title="Stash to Watch Later"
                                  >
                                    <Bookmark className="w-3.5 h-3.5" />
                                  </button>
                                )}

                                {video.status === 'watched' && (
                                  <button
                                    onClick={() => handleRequeue(video)}
                                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                                    title="Re-queue this video"
                                    aria-label="Re-queue this video"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                  </button>
                                )}

                                <button
                                  onClick={() => syncDeleteVideo(video.id)}
                                  className="p-1.5 rounded-lg bg-[#181e2e] hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 transition-colors"
                                  title="Delete video request"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                        </>
                      </div>
                    </div>
                  );
}
