import React from 'react';
export default function PlaybackFailure({ onRetry, onSkip, url, message, busy = false }) {
  return <div role="alert" className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center">
    <h3 className="text-lg font-bold text-white">This video could not start</h3>
    <p className="max-w-sm text-sm text-slate-300">{message || 'Your request is still here. Retry it, open the original, or choose the next video.'}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" onClick={onRetry} disabled={busy} className="rounded-lg bg-purple-700 px-4 py-2 font-bold text-white disabled:opacity-50">Retry video</button>
      <a href={url} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-slate-600 px-4 py-2 text-white">Open original</a>
      <button type="button" onClick={onSkip} className="rounded-lg border border-slate-600 px-4 py-2 text-white">Skip video</button>
    </div>
  </div>;
}
