import React from 'react';
import { RotateCcw, SkipForward } from 'lucide-react';
export default function TransportNavigation({ isStaff, onPrevious, onNext }) {
  if (!isStaff) return null;
  return <>
    <button type="button" onClick={onPrevious} className="gachi-control-btn flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-all active:scale-95" title="Return to the most recently played video" aria-label="Previous track">
      <RotateCcw className="h-4 w-4" /><span>Previous</span>
    </button>
    <button type="button" onClick={onNext} className="gachi-control-btn gachi-control-btn-primary flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-95" title="Skip to the next video" aria-label="Next track">
      <SkipForward className="h-4 w-4" /><span>Next Track</span>
    </button>
  </>;
}
