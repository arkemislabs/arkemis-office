// The worksheet canvas: virtualised painting of the visible cells (paint.ts), pointer and wheel
// input, the scrollbars, the hidden text field that turns typing into an edit, and the in-cell
// editor overlay.
// Translated from gridcraft crates/ui-egui/src/grid/show.rs (the frame: geometry, painting order,
// scrollbars sized to the used range or the view, whichever is larger), interact.rs and
// keyboard.rs (through view.ts), and grid/editor.rs (the in-cell editor: placed on the cell, as
// wide as its text up to the window, in the cell's font) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactElement} from 'react';
import type {GridView, Mods} from './view';
import {paintGrid} from './paint';
import {cssFont} from './paint';
import {FormulaInput} from './FormulaInput';
import {styleAt, sheetView} from '../../../../core/grid/model/workbook.mjs';
import {usedBounds} from '../../../../core/grid/model/store.mjs';
import {wheelZoomStep} from './geo';
import {FilterMenu, ListPicker, InputMessage} from './DataPopups';

/** The span of sheet units a window's scroll position is a fraction of when two windows scroll together. */
const SYNC_SPAN_X = 2_000_000, SYNC_SPAN_Y = 25_000_000;

/**
 * Sheet Right-to-Left: everything is laid out left to right as usual and mirrored across the canvas on screen, the text drawn
 * the right way round and anchored at the mirrored point with its alignment swapped (gridcraft grid/geo.rs `mirror_painted`).
 * Returns the function that puts the context back.
 */
function mirrorText(ctx: CanvasRenderingContext2D) {
  const orig = ctx.fillText;
  const swap: Record<string, CanvasTextAlign> = {left: 'right', right: 'left', start: 'end', end: 'start', center: 'center'};
  (ctx as any).fillText = function (text: string, x: number, y: number, maxWidth?: number) {
    const m = ctx.getTransform();
    const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
    const align = ctx.textAlign;
    ctx.save();
    ctx.setTransform(-m.a, -m.b, m.c, m.d, px, py);
    ctx.textAlign = swap[align] ?? align;
    if (maxWidth === undefined) orig.call(ctx, text, 0, 0); else orig.call(ctx, text, 0, 0, maxWidth);
    ctx.restore();
  };
  return () => { delete (ctx as any).fillText; };
}

const modsOf =(e: {shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean}): Mods => ({shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey});

/** Keys while the editor (cell or bar) has the caret: commit, cancel, Alt+Enter, autocomplete, point mode. */
export function editorKey(view: GridView, e: KeyboardEvent<HTMLTextAreaElement>) {
  const ed = view.editor;
  if (!ed) return;
  const mods = modsOf(e);
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.nativeEvent.isComposing) return;
  switch (e.key) {
    case 'Enter': {
      if (e.altKey) {
        // Alt+Enter: a line break in the cell.
        stop();
        const el = e.currentTarget;
        const s = el.selectionStart, t = el.value;
        view.setEditText(t.slice(0, s) + '\n' + t.slice(el.selectionEnd), s + 1);
        return;
      }
      stop();
      if (ed.autocomplete.length && view.acceptAutocomplete()) return;
      const array = e.ctrlKey && e.shiftKey;
      void view.commit(array || e.ctrlKey ? 0 : e.shiftKey ? -1 : 1, 0, {fillSelection: e.ctrlKey && !e.shiftKey, array});
      return;
    }
    case 'Tab':
      stop();
      if (ed.autocomplete.length && view.acceptAutocomplete()) return;
      void view.commit(0, e.shiftKey ? -1 : 1);
      return;
    case 'Escape':
      stop();
      if (ed.autocomplete.length) { view.editor = {...ed, autocomplete: []}; view.changed(); return; }
      view.cancelEdit();
      return;
    case 'F2': stop(); view.toggleEditMode(); return;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      if (e.ctrlKey || e.metaKey) return;
      if (view.editorArrow(e.key, mods)) stop();
      return;
    default: return;
  }
}

export function GridCanvas({view}: {view: GridView}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const vbar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({w: 800, h: 500});
  const [cursor, setCursor] = useState('cell');
  const frame = useRef(0);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setSize({w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height))}); });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height))});
    return () => ro.disconnect();
  }, []);

  const paint = useCallback(() => {
    frame.current = 0;
    const c = canvas.current;
    if (!c) return;
    let content: any;
    try { content = view.content(); } catch { return; }
    const dpr = window.devicePixelRatio || 1;
    const w = size.w - 14, h = size.h;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const si = view.sheetIndex();
    const sheet = content.sheets[si];
    const geo = view.geoFor(sheet, w, h);
    const sel = view.sel();
    const d = view.drag;
    const rtl = sheetView(sheet).rightToLeft === true;
    let unmirror = () => {};
    if (rtl) { ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1); unmirror = mirrorText(ctx); }
    paintGrid({
      ctx, geo, content, si, engine: view.engine(), sel,
      editing: view.editor && view.editor.sheet === si ? view.editor.cell : null,
      refs: view.refsOnSheet(),
      fillTarget: d?.kind === 'fill' ? d.target : null,
      showFillHandle: view.has('edit.autoFill') && sel.ranges.length === 1 && !view.editor,
      resize: d?.kind === 'resizeCol' ? {axis: 'cols', line: d.col, size: d.size} : d?.kind === 'resizeRow' ? {axis: 'rows', line: d.row, size: d.size} : null,
      circles: view.circles(), arrow: view.listArrow(), arrowOpen: !!view.listPicker, filterOpen: view.filterMenu,
      selectedObject: view.selectedObject(), liveObject: view.liveObject(), pickedObjects: view.selectedObjects(), ready: () => view.changed(),
      pageBreakPreview: view.pageBreakPreview(),
      hoverCell: view.drag ? null : view.hoverCell, showAllNotes: view.showAllNotes(),
      ink: view.inkOverlay(), hiddenInk: view.hiddenInk(),
    });
    if (rtl) { unmirror(); ctx.restore(); }
    // Vertical scrollbar extent: the used range or the view, whichever is further, plus a screen.
    const bar = vbar.current;
    if (bar) {
      const used = usedBounds(sheet);
      const s = view.scrollOf();
      const room = (geo.cells.h - geo.frozenH) / geo.z;
      const usedBottom = used ? geo.scrollTopOf(used.r1 + 1) : 0;
      const extent = Math.max(usedBottom, s.y + room) + room;
      const spacer = bar.firstElementChild as HTMLElement;
      const px = Math.min(extent * geo.z, 30_000_000);
      if (spacer.style.height !== `${px}px`) spacer.style.height = `${px}px`;
      const top = Math.round(s.y * geo.z);
      if (Math.abs(bar.scrollTop - top) > 1) bar.scrollTop = top;
    }
  }, [view, size]);

  const invalidate = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(paint); }, [paint]);
  useEffect(() => { paint(); }, [paint]);
  useEffect(() => view.subscribe(invalidate), [view, invalidate]);
  useEffect(() => view.session.subscribe(() => invalidate()), [view, invalidate]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // Synchronous Scrolling (View > Window): while two windows are side by side, the scroll position of each goes to the
  // other, as a fraction of a fixed span of sheet units (the window service clamps to 0..1), so both show the same place.
  const synced = useRef({x: 0, y: 0});
  useEffect(() => {
    const w = (window as any).studio?.windows;
    if (!w?.onScroll) return;
    return w.onScroll((m: {top: number; left: number}) => {
      if (!w.state?.()?.syncScroll) return;
      synced.current = {x: m.left * SYNC_SPAN_X, y: m.top * SYNC_SPAN_Y};
      view.setScroll(synced.current.x, synced.current.y);
    });
  }, [view]);
  useEffect(() => view.subscribe(() => {
    const w = (window as any).studio?.windows;
    if (!w?.scroll || !w.state?.()?.syncScroll) return;
    const s = view.scrollOf();
    if (s.x === synced.current.x && s.y === synced.current.y) return;
    synced.current = {x: s.x, y: s.y};
    w.scroll({top: s.y / SYNC_SPAN_Y, left: s.x / SYNC_SPAN_X});
  }), [view]);

  // Keep the hidden field focused while the grid is in Ready mode.
  useEffect(() => { if (!view.editor && document.activeElement === document.body) input.current?.focus({preventScroll: true}); });

  const point = (e: {clientX: number; clientY: number}) => {
    const r = canvas.current!.getBoundingClientRect();
    // A right-to-left sheet is mirrored on screen: the pointer is mapped back to the layout.
    const mirrored = view.geo?.sheet && sheetView(view.geo.sheet).rightToLeft === true;
    return {x: mirrored ? r.width - (e.clientX - r.left) : e.clientX - r.left, y: e.clientY - r.top};
  };
  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const {x, y} = point(e);
    canvas.current?.setPointerCapture(e.pointerId);
    void view.pointerDown(x, y, modsOf(e), e.button, e.detail).then(() => { if (!view.editor) input.current?.focus({preventScroll: true}); });
  };
  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const {x, y} = point(e);
    if (view.drag) view.pointerMove(x, y);
    const g = view.geo;
    view.setHover(g && !view.drag && x >= g.cells.x && y >= g.cells.y ? g.cellAt(x, y) : null);
    const c = view.cursorAt(x, y);
    if (c !== cursor) setCursor(c);
  };
  const onPointerUp = (e: RPointerEvent<HTMLCanvasElement>) => {
    const {x, y} = point(e);
    try { canvas.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    void view.pointerUp(x, y, modsOf(e));
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const g = view.geo;
    if (!g) return;
    if (e.ctrlKey) {
      // Ctrl+wheel zooms one ladder step a notch (view.zoom), when the zoom command exists.
      if (view.has('view.zoom')) {
        const zoom = Math.round(view.zoomPercent() ?? g.z * 100);
        void view.run('view.zoom', {percent: wheelZoomStep(zoom, e.deltaY < 0)});
      }
      return;
    }
    const k = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? g.cells.h : 1;
    const s = view.scrollOf();
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * k / g.z, dy = (e.shiftKey ? 0 : e.deltaY) * k / g.z;
    view.setScroll(s.x + dx, s.y + dy);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (view.editor || e.nativeEvent.isComposing || e.defaultPrevented) return;
    const known = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Tab', 'F2', 'Delete', 'Backspace', ' ', 'a', 'A'];
    if (!known.includes(e.key)) return;
    if (e.key === ' ' && !e.ctrlKey && !e.shiftKey && !e.metaKey) return;
    if ((e.key === 'a' || e.key === 'A') && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    void view.key(e.key, modsOf(e));
  };
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const text = el.value;
    el.value = '';
    if ((e.nativeEvent as InputEvent).isComposing) return;
    if (text) view.typeText(text);
  };

  // The in-cell editor overlay.
  let editor: ReactElement | null = null;
  const ed = view.editor;
  const g = view.geo;
  if (ed && g && ed.sheet === view.sheetIndex()) {
    const content = view.content();
    const st = styleAt(content, content.sheets[ed.sheet], ed.cell.row, ed.cell.col);
    const r = g.cellRect(ed.cell);
    const font = cssFont(st.font, g.z);
    const right = g.cells.x + g.cells.w;
    const flip = sheetView(content.sheets[ed.sheet]).rightToLeft === true;
    const cw = size.w - 14;
    editor = <FormulaInput view={view} where="cell" className="is-cell" autoFocus={!ed.fromFormulaBar} fontCss={font}
      style={{...(flip ? {direction: 'rtl' as const} : {}), left: flip ? cw - r.x - r.w - 1 : r.x - 1, top: r.y - 1, minWidth: r.w + 2, maxWidth: Math.max(right - r.x, r.w + 2), minHeight: r.h + 2,
        background: st.fill.pattern === 'solid' && st.fill.fg ? undefined : '#fff'}}
      onKey={e => editorKey(view, e)}/>;
  }

  return <div className="grid-canvas-host" ref={host}>
    <canvas ref={canvas} className="grid-canvas" style={{cursor}} role="grid" aria-label="Worksheet"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => view.setHover(null)} onWheel={onWheel}
      onDoubleClick={e => e.preventDefault()}/>
    <textarea ref={input} className="grid-keys" aria-label="Cell input" spellCheck={false} autoComplete="off"
      onKeyDown={onKeyDown} onInput={onInput} tabIndex={0}/>
    <div className="grid-vbar" ref={vbar} onScroll={e => {
      const geo = view.geo; if (!geo) return;
      const y = e.currentTarget.scrollTop / geo.z;
      const s = view.scrollOf();
      if (Math.abs(y - s.y) * geo.z > 1) view.setScroll(s.x, y);
    }}><div/></div>
    {editor}
    <InputMessage view={view}/>
    <FilterMenu view={view}/>
    <ListPicker view={view}/>
  </div>;
}

/** The horizontal scrollbar beside the sheet tabs (show.rs `horizontal_scrollbar`). */
export function HorizontalBar({view}: {view: GridView}) {
  const bar = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useEffect(() => view.subscribe(() => tick(t => t + 1)), [view]);
  useLayoutEffect(() => {
    const b = bar.current, g = view.geo;
    if (!b || !g) return;
    let sheet: any;
    try { sheet = view.sheet(); } catch { return; }
    const used = usedBounds(sheet);
    const s = view.scrollOf();
    const room = (g.cells.w - g.frozenW) / g.z;
    const usedRight = used ? g.scrollLeftOf(used.c1 + 1) : 0;
    const extent = Math.max(usedRight, s.x + room) + room;
    (b.firstElementChild as HTMLElement).style.width = `${Math.round(extent * g.z * (b.clientWidth / Math.max(g.cells.w, 1)))}px`;
    const left = Math.round(s.x * g.z * (b.clientWidth / Math.max(g.cells.w, 1)));
    if (Math.abs(b.scrollLeft - left) > 1) b.scrollLeft = left;
  });
  return <div className="grid-hbar" ref={bar} onScroll={e => {
    const g = view.geo; if (!g) return;
    const ratio = e.currentTarget.clientWidth / Math.max(g.cells.w, 1);
    const x = e.currentTarget.scrollLeft / ratio / g.z;
    const s = view.scrollOf();
    if (Math.abs(x - s.x) * g.z > 1) view.setScroll(x, s.y);
  }}><div/></div>;
}
