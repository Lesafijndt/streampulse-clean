import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Grip, Minus, Plus } from 'lucide-react';

const DEFAULT = {
  stats: { order: 0, span: 2, height: 0 },
  player: { order: 1, span: 7, height: 0 },
  queue: { order: 2, span: 3, height: 0 },
};
const WidgetContext = createContext(null);
const KEY_PREFIX = 'whale-cum:widget-layout:v1:';
const clamp = (n, low, high) => Math.max(low, Math.min(high, Math.round(Number(n) || low)));

export function normalizeWidgetLayout(input) {
  const value = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(Object.entries(DEFAULT).map(([id, fallback]) => {
    const candidate = value[id] || {};
    return [id, {
      order: clamp(candidate.order ?? fallback.order, 0, 2),
      span: clamp(candidate.span ?? fallback.span, 2, 12),
      height: clamp(candidate.height ?? fallback.height, 0, 1600),
    }];
  }));
}

export function WorkspaceGrid({ username, children }) {
  const account = String(username || '').toLowerCase();
  const [layout, setLayout] = useState(() => {
    try { return normalizeWidgetLayout(JSON.parse(localStorage.getItem(KEY_PREFIX + account) || 'null')); }
    catch { return normalizeWidgetLayout(null); }
  });
  const dragged = useRef('');
  // Never inherit layout from a different signed-in account on this device.
  useEffect(() => {
    if (!account) return;
    try { localStorage.setItem(KEY_PREFIX + account, JSON.stringify(layout)); } catch { /* browser may block storage */ }
  }, [account, layout]);
  const api = useMemo(() => ({
    layout,
    begin: id => { dragged.current = id; },
    drop: id => {
      const from = dragged.current;
      dragged.current = '';
      if (!from || from === id || !layout[from] || !layout[id]) return;
      setLayout(previous => ({
        ...previous, [from]: { ...previous[from], order: previous[id].order },
        [id]: { ...previous[id], order: previous[from].order },
      }));
    },
    resize: (id, delta) => setLayout(previous => ({
      ...previous, [id]: { ...previous[id], span: clamp(previous[id].span + delta, 2, 12) },
    })),
    setHeight: (id, value) => setLayout(previous => ({
      ...previous, [id]: { ...previous[id], height: clamp(value, 0, 1600) },
    })),
  }), [layout]);
  return <WidgetContext.Provider value={api}>
    <div className="gachi-workspace gachi-modular-grid flex-1 w-full max-w-[1740px] mx-auto p-3 sm:p-4 lg:p-5">{children}</div>
  </WidgetContext.Provider>;
}

export function WorkspacePanel({ id, title, children }) {
  const api = useContext(WidgetContext);
  if (!api) throw new Error('WorkspacePanel requires WorkspaceGrid');
  const sizing = api.layout[id];
  const ref = useRef(null);
  const handleResizeStart = event => {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientY;
    const initial = ref.current?.getBoundingClientRect().height || 0;
    const move = moveEvent => {
      if (ref.current) ref.current.style.minHeight = Math.max(170, initial + moveEvent.clientY - start) + 'px';
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      api.setHeight(id, ref.current?.getBoundingClientRect().height || 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done, { once: true });
  };
  return <div ref={ref} data-widget={id} className="gachi-modular-item relative min-w-0"
    style={{ order: sizing.order, '--widget-span': sizing.span, minHeight: sizing.height || undefined }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
    onDrop={event => { event.preventDefault(); api.drop(id); }}>
    <div draggable onDragStart={event => { api.begin(id); event.dataTransfer.effectAllowed = 'move'; }}
      className="gachi-widget-handle flex items-center justify-between rounded-t-xl border border-white/10 bg-[#16101f] px-3 py-1.5 text-[10px] text-slate-300 cursor-grab select-none">
      <span className="flex items-center gap-2 font-bold"><Grip className="h-3.5 w-3.5"/> {title}</span>
      <span className="flex items-center gap-1">
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label={'Narrow ' + title} title="Narrow widget" onPointerDown={e => e.stopPropagation()} onClick={e => {e.stopPropagation(); api.resize(id, -1);}}><Minus className="h-3 w-3"/></button>
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label={'Widen ' + title} title="Widen widget" onPointerDown={e => e.stopPropagation()} onClick={e => {e.stopPropagation(); api.resize(id, 1);}}><Plus className="h-3 w-3"/></button>
      </span>
    </div>
    <div className="gachi-widget-content min-w-0">{children}</div>
    <div className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-ns-resize rounded-tl bg-purple-600/50"
      role="separator" aria-label={'Resize ' + title + ' height'} onPointerDown={handleResizeStart}/>
  </div>;
}
