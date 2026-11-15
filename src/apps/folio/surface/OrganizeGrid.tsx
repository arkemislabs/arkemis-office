// Organize Pages (Acrobat's page grid; printcraft crates/ui-egui/src/canvas/organize.rs): every page
// as a thumbnail in a grid. Click selects a page, Ctrl/⌘-click toggles it, Shift-click selects the
// range from the anchor, the corner check box toggles one page; double-click opens the page. Drag
// moves the selected pages (or the one grabbed) to the gap the pointer is over, Ctrl (Option on
// macOS) copies them there instead; the "+" in a gap inserts pages from a file there. Delete deletes
// the selected pages; Escape closes the grid. The page commands are the model's (page.move,
// page.duplicate, page.insert, page.delete), so undo, the bridge and the contextual tab share them.
// The right-click menu is the spec's `organize-grid-page` (data-context).

import {useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent} from 'react';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import {viewSize} from '../../../../core/folio/lib/geom.mjs';
import {Thumb} from './SidePanel';
import type {PdfSource} from './pdf';

const BASE_CELL = 176, GAP = 20, LABEL = 30, PAD = 12;
const pageAddr = (id: string) => `/pg:${encodeURIComponent(id)}`;

/**
 * Where a page of `size` is drawn in a cell's picture area (cell_page_rect): as large as the area
 * allows and centred, so a landscape or rotated page fills the width in the middle. A damaged page
 * size (zero, NaN, infinite) draws square.
 */
export function cellPicture(size: {width: number; height: number}, area: number): {w: number; h: number} {
  const ok = (v: number) => Number.isFinite(v) && v > 0;
  const ar = ok(size.width) && ok(size.height) ? size.width / size.height : 1;
  return ar >= 1 ? {w: area, h: area / ar} : {w: area * ar, h: area};
}

/** The gap (0 = before the first page, n = after the last) nearest to a point in the grid. */
function gapAt(x: number, y: number, cols: number, n: number, CELL: number): number {
  const row = Math.max(0, Math.floor((y - PAD) / (CELL + LABEL + GAP)));
  const col = Math.max(0, Math.min(cols, Math.round((x - PAD) / (CELL + GAP))));
  return Math.max(0, Math.min(n, row * cols + col));
}

export function OrganizeGrid({content, source, exec, selected, current, select, openPage, zoom = 1}: {
  content: any; source: PdfSource | null; exec: (id: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Selected page indices (the session selection's page addresses). */
  selected: number[]; current: number;
  /** Replace the page selection (indices). */
  select: (indices: number[]) => void;
  openPage: (i: number) => void;
  /** The size of the pages in the grid (organize.zoom: 0.5 to 3, 1 is 100 %). */
  zoom?: number;
}) {
  const CELL = Math.round(BASE_CELL * zoom);
  const pages: any[] = content.pages;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [drag, setDrag] = useState<{from: number; x0: number; y0: number; active: boolean; gap: number; copy: boolean} | null>(null);
  const anchor = useRef<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The grid opens scrolled to the page being read.
  useEffect(() => { box.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({block: 'nearest'}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (CELL + GAP)));
  const chosen = useMemo(() => new Set(selected.length ? selected : [current]), [selected, current]);
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  const click = (i: number, e: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
    const toggle = mac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey) {
      const from = anchor.current ?? current;
      const [a, b] = from < i ? [from, i] : [i, from];
      select(Array.from({length: b - a + 1}, (_, k) => a + k));
      return;
    }
    anchor.current = i;
    if (toggle) {
      // The first toggle keeps the page being read selected too (an empty selection means it).
      const base = selected.length ? selected : [current];
      select(base.includes(i) ? base.filter(k => k !== i) : [...base, i].sort((a, b) => a - b));
    } else select([i]);
  };
  const moving = (from: number) => (chosen.has(from) ? [...chosen].sort((a, b) => a - b) : [from]);
  const point = (e: {clientX: number; clientY: number}) => {
    const r = box.current!.getBoundingClientRect();
    return {x: e.clientX - r.left + box.current!.scrollLeft, y: e.clientY - r.top + box.current!.scrollTop};
  };
  const onDown = (i: number, e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = point(e);
    setDrag({from: i, x0: p.x, y0: p.y, active: false, gap: i, copy: false});
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = point(e);
    const active = drag.active || Math.hypot(p.x - drag.x0, p.y - drag.y0) > 6;
    setDrag({...drag, active, gap: gapAt(p.x, p.y, cols, pages.length, CELL), copy: mac ? e.altKey : e.ctrlKey});
  };
  const onUp = async (i: number, e: RPointerEvent<HTMLDivElement>) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (!d.active) { click(i, e); return; }
    const list = moving(d.from);
    if (d.copy) { await exec('page.duplicate', {pages: list, at: d.gap}); return; }
    // page.move's `to` counts positions without the moving pages.
    const to = d.gap - list.filter(k => k < d.gap).length;
    if (list.every((k, j) => k === to + j)) return;
    await exec('page.move', {pages: list, to});
  };

  const rows = Math.ceil(pages.length / cols);
  const gapPos = (g: number) => {
    const row = Math.floor(Math.min(g, pages.length - 1 < 0 ? 0 : g === pages.length ? pages.length - 1 : g) / cols);
    const col = g === pages.length && pages.length ? (pages.length - 1) % cols + 1 : g % cols;
    return {left: PAD + col * (CELL + GAP) - GAP / 2, top: PAD + row * (CELL + LABEL + GAP)};
  };
  return <div ref={box} className="folio-organize" role="listbox" aria-label="Pages" aria-multiselectable="true" tabIndex={0}
    onKeyDown={e => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void exec('page.delete', {pages: [...chosen]}); }
      else if (e.key === 'Escape') { e.preventDefault(); void exec('page.organize', {open: false}); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); select(pages.map((_, k) => k)); }
    }}>
    <div className="folio-organize-inner" style={{height: PAD * 2 + rows * (CELL + LABEL + GAP)}}>
      {pages.map((pg, i) => {
        const left = PAD + (i % cols) * (CELL + GAP), top = PAD + Math.floor(i / cols) * (CELL + LABEL + GAP);
        const pic = cellPicture(viewSize(pg), CELL - 24);
        const on = chosen.has(i) && (selected.length > 0 || i === current);
        return <div key={pg.id} className={`folio-organize-cell${on ? ' is-selected' : ''}${drag?.active && moving(drag.from).includes(i) ? ' is-moving' : ''}`}
          style={{left, top, width: CELL, height: CELL + LABEL}} role="option" aria-selected={on} aria-label={`Page ${pageLabel(content, i)}`}
          data-index={i} data-context="organize-grid-page"
          onPointerDown={e => onDown(i, e)} onPointerMove={onMove} onPointerUp={e => void onUp(i, e)}
          onDoubleClick={() => openPage(i)}
          onContextMenu={() => { if (!chosen.has(i) || !selected.length) select([i]); }}>
          <div className="folio-organize-picture" style={{width: CELL, height: CELL}}>
            <div style={{width: pic.w, height: pic.h}}><Thumb content={content} page={pg} source={source} width={pic.w} height={pic.h}/></div>
          </div>
          <button type="button" className={`folio-organize-check${on ? ' is-on' : ''}`} aria-label={`Select page ${pageLabel(content, i)}`} aria-pressed={on}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); const base = selected.length ? selected : []; select(base.includes(i) ? base.filter(k => k !== i) : [...base, i].sort((a, b) => a - b)); }}/>
          <span className="folio-organize-label">{pageLabel(content, i)}</span>
        </div>;
      })}
      {Array.from({length: pages.length + 1}, (_, g) => {
        const at = gapPos(g);
        return <button key={`gap${g}`} type="button" className="folio-organize-gap" style={{left: at.left - 11, top: at.top + CELL / 2 - 11}}
          aria-label={g === pages.length ? 'Insert pages after the last page' : `Insert pages before page ${pageLabel(content, g)}`}
          onClick={() => void exec('page.insert', {at: g})}>+</button>;
      })}
      {drag?.active ? (() => { const at = gapPos(drag.gap); return <div className={`folio-organize-drop${drag.copy ? ' is-copy' : ''}`} style={{left: at.left - 1.5, top: at.top, height: CELL}} aria-hidden="true"/>; })() : null}
    </div>
  </div>;
}

/** The pages the session selection names, as indices. */
export function selectedIndices(selection: any, pages: any[]): number[] {
  const ids = new Set<string>();
  for (const r of selection?.ranges ?? []) for (const a of [r.anchor, r.focus]) {
    const m = /^\/pg:([^/]+)$/.exec(String(a ?? ''));
    if (m) ids.add(decodeURIComponent(m[1]));
  }
  return pages.map((p, i) => (ids.has(p.id) ? i : -1)).filter(i => i >= 0);
}
export const pageSelection = (pages: any[], indices: number[]) => ({ranges: indices.map(i => ({anchor: pageAddr(pages[i].id), focus: pageAddr(pages[i].id)})), primary: 0});
