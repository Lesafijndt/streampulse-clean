import React from 'react';
import { Keyboard } from 'lucide-react';
export default function KeyboardShortcutHint({ isStaff }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-slate-500">
    <Keyboard className="h-3 w-3" />
    <span>Keyboard: Space play/pause · M mute{isStaff ? ' · ← / P previous · → / N next' : ''}</span>
  </div>;
}
