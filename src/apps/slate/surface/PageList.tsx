// The page list (OneNote's page tabs pane, docs/spec/slate.json panes › page-list; F:slate).
//
// Add Page at the top, then the section's pages in order: titles ("Untitled page" when empty),
// subpages indented one step per level (two at most), the current page highlighted. Rows are
// virtualized so a 2,000-page section scrolls as lightly as a short one. Clicking a page opens it
// (the selection moves to /pg:<id>); Add Page runs `page.new` (Ctrl+N), shown only while that
// command can run here.

import {useEffect, useLayoutEffect, useRef, useState} from 'react';

export interface PageRow { id: string; title: string; level: number; unread?: boolean }

const ROW_MOUSE = 30, ROW_TOUCH = 42;
const OVERSCAN = 8;

export function PageList({rows, current, color, canAdd, onSelect, onAdd, touch = false}: {
  touch?: boolean; rows: PageRow[]; current: string | null; color: string | null; canAdd: boolean;
  onSelect: (id: string) => void; onAdd: () => void;
}) {
  const ROW = touch ? ROW_TOUCH : ROW_MOUSE;
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({top: 0, height: 600});
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setScroll({top: el.scrollTop, height: el.clientHeight});
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Keep the current page in view when it changes (Ctrl+Page Down, a new page at the end).
  useEffect(() => {
    const el = scroller.current;
    const i = rows.findIndex(r => r.id === current);
    if (!el || i < 0) return;
    const top = i * ROW, bottom = top + ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [current, rows]);
  const first = Math.max(0, Math.floor(scroll.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.height) / ROW) + OVERSCAN);
  const visible = rows.slice(first, last);
  return <nav className="slate-pages" aria-label="Pages" style={color ? {['--slate-section' as any]: color} : undefined}>
    {canAdd ? <button type="button" className="slate-add-page" onClick={onAdd} title="Add Page (Ctrl+N)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      <span>Add Page</span>
    </button> : null}
    <div className="slate-pages-scroll" ref={scroller} onScroll={e => setScroll({top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight})}
      role="listbox" aria-label="Pages in this section" aria-activedescendant={current ? `slate-page-${current}` : undefined}>
      <div style={{height: rows.length * ROW, position: 'relative'}}>
        {visible.map((r, k) => {
          const i = first + k;
          return <div key={r.id} id={`slate-page-${r.id}`} role="option" aria-selected={r.id === current}
            className={`slate-page-tab level-${r.level}${r.id === current ? ' is-current' : ''}${r.title ? '' : ' is-untitled'}${r.unread ? ' is-unread' : ''}`}
            style={{top: i * ROW}} onMouseDown={e => { e.preventDefault(); onSelect(r.id); }} title={r.title || 'Untitled page'}>
            <span>{r.title || 'Untitled page'}</span>
          </div>;
        })}
      </div>
      {!rows.length ? <p className="slate-pages-empty">This section has no pages.</p> : null}
    </div>
  </nav>;
}
