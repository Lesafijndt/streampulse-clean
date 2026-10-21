import React from 'react';
const TONES = {
  success: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  warning: 'border-amber-300/25 bg-amber-300/10 text-amber-100',
  error: 'border-rose-300/25 bg-rose-300/10 text-rose-200',
  neutral: 'border-white/10 bg-white/[0.04] text-slate-300'
};
export default function ConnectionStatusPill({ children, tone = 'neutral', className = '' }) {
  return <span className={`gachi-status-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide ${TONES[tone] || TONES.neutral} ${className}`}>{children}</span>;
}
