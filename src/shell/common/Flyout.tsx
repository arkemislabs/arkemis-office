// Floating surfaces the shell shares: flyouts (menus, palettes, galleries, collapsed groups), the
// delayed rich tooltip, and a small windowed list for long option lists (fonts).

import {createPortal} from 'react-dom';
import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';

export type Placement = 'below' | 'below-end' | 'right' | 'above';

/** A glass flyout anchored to an element; closes on an outside press, Escape or when the anchor scrolls away. */
export function Flyout({anchor, open, onClose, placement = 'below', children, className, label, role = 'menu', initialFocus = true, matchWidth = false}: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; placement?: Placement; children: ReactNode;
  className?: string; label?: string; role?: string; initialFocus?: boolean; matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({visibility: 'hidden', top: 0, left: 0});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, gap = 4;
      let top = placement === 'right' ? a.top - 5 : placement === 'above' ? a.top - h - gap : a.bottom + gap;
      let left = placement === 'right' ? a.right + 2 : placement === 'below-end' ? a.right - w : a.left;
      if (left + w > vw - 8) left = placement === 'right' ? Math.max(8, a.left - w - 2) : Math.max(8, vw - w - 8);
      if (left < 8) left = 8;
      if (top + h > vh - 8) top = placement === 'right' ? Math.max(8, vh - h - 8) : Math.max(8, a.top - h - gap);
      if (top < 8) top = 8;
      setPos({top, left, visibility: 'visible', ...(matchWidth ? {minWidth: a.width} : {}), maxHeight: vh - 16});
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [open, anchor, placement, matchWidth]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // A nested flyout (submenu) counts as inside.
      if ((t as Element).closest?.('.shell-flyout')) return;
      onClose();
    };
    const blur = () => onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', blur);
    if (initialFocus) requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true]),[role=menuitemcheckbox]:not([aria-disabled=true]),[role=option],button:not(:disabled),input');
      first?.focus({preventScroll: true});
    });
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('blur', blur); };
  }, [open, onClose, anchor, initialFocus]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`shell-flyout${className ? ' ' + className : ''}`} role={role} aria-label={label} style={pos}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchor.current?.focus(); return; }
        if (role === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
          const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true]), .shell-swatch') ?? [])];
          if (!items.length) return;
          e.preventDefault();
          const i = items.indexOf(document.activeElement as HTMLElement);
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
          items[next].focus();
        }
      }}>{children}</div>,
    document.body);
}

/**
 * The rich tooltip: label, shortcut and description, shown after a short delay over any element
 * carrying `data-tip` (Office's ScreenTip). One listener for the whole window.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{title: string; keys: string | null; desc: string | null; pending: boolean; x: number; y: number; below: boolean} | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el === current) return;
      clearTimeout(timer);
      current = el;
      setTip(null);
      if (!el || el.closest('.shell-flyout[role=menu]')) return;
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.bottom + 90 < window.innerHeight;
        setTip({title: el.getAttribute('data-tip') ?? '', keys: el.getAttribute('data-tip-keys'), desc: el.getAttribute('data-tip-desc'),
          pending: el.getAttribute('data-pending') === 'true', x: Math.min(r.left, window.innerWidth - 300), y: below ? r.bottom + 6 : r.top - 6, below});
      }, 550);
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => { clearTimeout(timer); window.removeEventListener('pointerover', over); window.removeEventListener('pointerdown', hide, true); window.removeEventListener('keydown', hide, true); window.removeEventListener('blur', hide); };
  }, []);
  if (!tip || !tip.title) return null;
  return createPortal(<div className={`shell-tooltip${tip.pending ? ' is-pending' : ''}`} role="tooltip"
    style={{left: Math.max(8, tip.x), top: tip.y, transform: tip.below ? undefined : 'translateY(-100%)'}}>
    <strong>{tip.title}{tip.keys ? <kbd>{tip.keys}</kbd> : null}</strong>
    {tip.desc ? <span>{tip.desc}</span> : null}
  </div>, document.body);
}

/** A fixed-row windowed list (font names: hundreds of rows, each drawn in its own face). */
export function VirtualList<T>({items, row = 26, height = 260, render, className, label, scrollTo}: {
  items: T[]; row?: number; height?: number; render: (item: T, index: number) => ReactNode; className?: string; label?: string; scrollTo?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (scrollTo !== undefined && scrollTo >= 0 && ref.current) {
      const want = Math.max(0, scrollTo * row - height / 2 + row / 2);
      ref.current.scrollTop = want;
      setTop(want);
    }
  }, [scrollTo, row, height]);
  const first = Math.max(0, Math.floor(top / row) - 4);
  const last = Math.min(items.length, Math.ceil((top + height) / row) + 4);
  return <div ref={ref} className={`shell-vlist${className ? ' ' + className : ''}`} role="listbox" aria-label={label} style={{height: Math.min(height, items.length * row + 2)}}
    onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}>
    <div style={{height: items.length * row, position: 'relative'}}>
      {items.slice(first, last).map((item, i) => <div key={first + i} className="shell-vlist-row" style={{position: 'absolute', top: (first + i) * row, height: row, left: 0, right: 0}}>
        {render(item, first + i)}
      </div>)}
    </div>
  </div>;
}

/** Installed font families (window.studio.fonts), loaded once per window. */
let fontCache: Promise<string[]> | null = null;
export function loadFonts(): Promise<string[]> {
  fontCache ??= (async () => {
    try { const r = await window.studio.fonts(); return [...new Set(r.families)].sort((a, b) => a.localeCompare(b)); }
    catch { return ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Segoe UI', 'Times New Roman', 'Verdana']; }
  })();
  return fontCache;
}
export function useFonts(enabled = true): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => { if (enabled) { let alive = true; loadFonts().then(f => { if (alive) setFonts(f); }); return () => { alive = false; }; } }, [enabled]);
  return fonts;
}
