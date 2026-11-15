// The side panel docked right of the pages: Page thumbnails and Bookmarks.
//
// Translated from printcraft crates/ui-egui/src/panels/side_panels.rs (docked right of the page,
// 330 px, resizable 260–520), panels/pages.rs (thumbnails at most 150 px wide in rows 16 px
// larger, the page label under each, the current page with a 2 px accent border and scrolled into
// view as little as it takes, a click goes to the page) and panels/bookmarks.rs (the outline tree
// with each title's bold/italic style; a click goes to its page; branches open and close) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).

import {useEffect, useMemo, useRef, useState, type ReactElement} from 'react';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import {viewSize, pageRotation, userToView} from '../../../../core/folio/lib/geom.mjs';
import {shownOnPage} from '../../../../core/folio/lib/pageview.mjs';
import {paintForm, recordAppearance, userToCanvas} from '../../../../core/folio/lib/content-paint.mjs';
import {viewText} from './viewText';
import {Glyph} from '../../../shell/icons/Icon';
import {outline, raster, refId, type OutlineNode, type PdfSource} from './pdf';
import {drawnByFile} from './PageView';

export function SidePanel({kind, width, onWidth, onClose, content, source, current, goToPage}: {
  kind: 'pages' | 'bookmarks'; width: number; onWidth: (w: number) => void; onClose: () => void;
  content: any; source: PdfSource | null; current: number; goToPage: (i: number) => void;
}) {
  const drag = useRef<{x: number; w: number} | null>(null);
  return <aside className="folio-side" style={{width}} aria-label={kind === 'pages' ? 'Page thumbnails' : 'Bookmarks'}>
    <div className="folio-side-grip" role="separator" aria-orientation="vertical"
      onPointerDown={e => { drag.current = {x: e.clientX, w: width}; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) onWidth(drag.current.w + (drag.current.x - e.clientX)); }}
      onPointerUp={() => { drag.current = null; }}/>
    <header className="folio-side-head">
      <h2>{kind === 'pages' ? 'Page thumbnails' : 'Bookmarks'}</h2>
      <button type="button" className="folio-side-close" aria-label="Close panel" onClick={onClose}><Glyph name="close" size={14}/></button>
    </header>
    {kind === 'pages' ? <Thumbnails content={content} source={source} current={current} width={width} goToPage={goToPage}/>
      : <Bookmarks content={content} source={source} current={current} goToPage={goToPage}/>}
  </aside>;
}

function Thumbnails({content, source, current, width, goToPage}: {content: any; source: PdfSource | null; current: number; width: number; goToPage: (i: number) => void}) {
  const pages: any[] = content.pages;
  const list = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const w = Math.min(150, Math.max(1, width - 40));
  const rows = useMemo(() => {
    const out: {top: number; h: number}[] = [];
    let y = 8;
    for (const p of pages) { const s = viewSize(p); const h = w * s.height / Math.max(1, s.width); out.push({top: y, h}); y += h + 16 + 22; }
    return {out, total: y + 8};
  }, [pages, w]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The current page's thumbnail scrolls into view, as little as it takes.
  useEffect(() => {
    const el = list.current, r = rows.out[current];
    if (!el || !r) return;
    if (r.top < el.scrollTop) el.scrollTop = r.top - 8;
    else if (r.top + r.h + 38 > el.scrollTop + el.clientHeight) el.scrollTop = r.top + r.h + 38 - el.clientHeight;
  }, [current, rows]);
  let first = 0;
  while (first < rows.out.length && rows.out[first].top + rows.out[first].h + 38 < top - 200) first++;
  const shown: number[] = [];
  for (let i = first; i < rows.out.length && rows.out[i].top < top + height + 200; i++) shown.push(i);
  return <div ref={list} className="folio-thumbs" onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}>
    <div style={{height: rows.total, position: 'relative'}}>
      {shown.map(i => <button key={pages[i].id} type="button" className={`folio-thumb${i === current ? ' is-current' : ''}`} style={{top: rows.out[i].top, width: w + 16}}
        aria-label={`Page ${pageLabel(content, i)}`} aria-current={i === current ? 'page' : undefined} onClick={() => goToPage(i)}>
        <Thumb content={content} page={pages[i]} source={source} width={w} height={rows.out[i].h}/>
        <span>{pageLabel(content, i)}</span>
      </button>)}
    </div>
  </div>;
}

export function Thumb({content, page, source, width, height}: {content: any; page: any; source: PdfSource | null; width: number; height: number}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const annots: any[] = page.annots ?? [];
  const loaded = content.folio === 2;
  useEffect(() => {
    if (!source) return;
    const ctrl = new AbortController();
    const dpr = window.devicePixelRatio || 1;
    const scale = width / viewSize(page).width * dpr;
    const shown = new Set<string>();
    for (const r of annots) if (drawnByFile(r, false) && shownOnPage(r)) { const id = refId(r.src); if (id) shown.add(id); }
    const timer = setTimeout(() => {
      raster(source, page.sourceIndex, pageRotation(page), scale, shown, ctrl.signal).then(c => {
        const el = canvas.current;
        if (!el || ctrl.signal.aborted) return;
        el.width = c.width; el.height = c.height;
        const ctx = el.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(c, 0, 0);
        if (!loaded) return;
        const m = userToCanvas((x: number, y: number) => userToView(page, x, y), scale);
        for (const r of annots) {
          if (!shownOnPage(r) || drawnByFile(r, false)) continue;
          const ap = recordAppearance(r, viewText);
          if (!ap) continue;
          ctx.save(); ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          try { paintForm(ctx, ap.form, ap.rect); } catch { /* skipped */ }
          ctx.restore();
        }
      }).catch(() => {});
    }, 120);
    return () => { clearTimeout(timer); ctrl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, page.sourceIndex, pageRotation(page), width, annots, loaded]);
  return <canvas ref={canvas} className="folio-thumb-canvas" style={{width, height}} aria-hidden="true"/>;
}

interface Node { key: string; title: string; page: number | null; children: Node[]; bold?: boolean; italic?: boolean }

function Bookmarks({content, source, current, goToPage}: {content: any; source: PdfSource | null; current: number; goToPage: (i: number) => void}) {
  const [fromFile, setFromFile] = useState<OutlineNode[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const pages: any[] = content.pages;
  useEffect(() => {
    if (Array.isArray(content.bookmarks) || !source) return;
    let alive = true;
    outline(source).then(o => { if (alive) setFromFile(o); }).catch(() => { if (alive) setFromFile([]); });
    return () => { alive = false; };
  }, [content.bookmarks, source]);
  // The model's bookmarks (core/pdf-bookmarks.mjs) once edited; until then the file's outline.
  const tree: Node[] = useMemo(() => {
    if (Array.isArray(content.bookmarks)) {
      const map = (list: any[], depth: string): Node[] => list.map((b, i) => ({key: `${depth}.${i}`, title: String(b.title ?? ''),
        page: (() => { const k = pages.findIndex(p => p.id === b.pageId); return k < 0 ? null : k; })(), children: map(b.children ?? [], `${depth}.${i}`),
        bold: !!b.bold, italic: !!b.italic}));
      return map(content.bookmarks, '0');
    }
    // The file's outline names source pages: each goes to the first page shown from it.
    const index = new Map<number, number>();
    pages.forEach((p, i) => { if (!index.has(p.sourceIndex)) index.set(p.sourceIndex, i); });
    const map = (list: OutlineNode[]): Node[] => list.map(n => ({...n, page: n.page === null ? null : index.get(n.page) ?? null, children: map(n.children)}));
    return map(fromFile ?? []);
  }, [content.bookmarks, fromFile, pages]);
  if (!tree.length) return <p className="folio-side-empty">{fromFile === null && !Array.isArray(content.bookmarks) ? 'Reading bookmarks…' : 'This document has no bookmarks.'}</p>;
  const row = (n: Node, depth: number): ReactElement => <li key={n.key}>
    <div className={`folio-bm${n.page === current ? ' is-current' : ''}`} style={{paddingLeft: 6 + depth * 16}}>
      {n.children.length ? <button type="button" className="folio-bm-twisty" aria-label={open.has(n.key) ? 'Collapse' : 'Expand'} aria-expanded={open.has(n.key)}
        onClick={() => setOpen(s => { const x = new Set(s); if (x.has(n.key)) x.delete(n.key); else x.add(n.key); return x; })}>
        <Glyph name={open.has(n.key) ? 'chevron-down' : 'chevron-right'} size={12}/></button> : <span className="folio-bm-leaf"/>}
      <button type="button" className="folio-bm-title" style={{fontWeight: n.bold ? 650 : undefined, fontStyle: n.italic ? 'italic' : undefined}}
        disabled={n.page === null} onClick={() => { if (n.page !== null) goToPage(n.page); }}>{n.title || 'Untitled'}</button>
    </div>
    {n.children.length && open.has(n.key) ? <ul>{n.children.map(c => row(c, depth + 1))}</ul> : null}
  </li>;
  return <ul className="folio-bms" role="tree">{tree.map(n => row(n, 0))}</ul>;
}
