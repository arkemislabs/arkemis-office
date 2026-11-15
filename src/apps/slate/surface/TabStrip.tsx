// The section tab strip's overflow (F:slate surface). OneNote keeps the current section's tab in
// view and, when the tabs do not fit, shows an arrow at the end of the strip that lists the
// sections and section groups whose tabs are hidden; choosing one opens it.

import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Glyph} from '../../../shell/icons/Icon';

export interface TabEntry { id: string; name: string; color?: string | null; group?: boolean }

export function TabStrip({entries, current, onOpen, children, after}: {
  entries: TabEntry[]; current: string | null; onOpen: (e: TabEntry) => void; children: ReactNode; after?: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [hidden, setHidden] = useState<TabEntry[] | null>(null);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length]);

  // Keep the current tab fully in view.
  useLayoutEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(current ?? '')}"]`);
    if (!el || !tab) return;
    if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
  }, [current, entries.length, overflow]);

  useEffect(() => {
    if (!hidden) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.slate-tab-more-menu, .slate-tab-more')) setHidden(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setHidden(null); };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); };
  }, [hidden]);

  const openMenu = () => {
    const el = strip.current;
    if (!el) return;
    const left = el.scrollLeft, right = left + el.clientWidth;
    const out: TabEntry[] = [];
    for (const e of entries) {
      const tab = el.querySelector<HTMLElement>(`[data-tab="${CSS.escape(e.id)}"]`);
      if (!tab || tab.offsetLeft < left || tab.offsetLeft + tab.offsetWidth > right) out.push(e);
    }
    setHidden(hidden ? null : out);
  };

  return <>
    <div className="slate-tab-strip" ref={strip}>{children}</div>
    {after}
    {overflow ? <button type="button" className="slate-tab is-more slate-tab-more" title="More sections" aria-label="More sections" aria-haspopup="menu"
      aria-expanded={!!hidden} onClick={openMenu}>
      <Glyph name="chevron-down" size={14}/>
    </button> : null}
    {hidden ? <div className="slate-tab-more-menu" role="menu">
      {hidden.map(e => <button key={e.id} type="button" role="menuitem" className={e.id === current ? 'is-current' : ''}
        onClick={() => { setHidden(null); onOpen(e); }}>
        {e.group
          ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
          : <i style={{background: e.color ?? '#b0b0b0'}} aria-hidden="true"/>}
        <span>{e.name}</span>
      </button>)}
    </div> : null}
  </>;
}
