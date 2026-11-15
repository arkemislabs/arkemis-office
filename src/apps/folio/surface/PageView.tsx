// One page of the folio page view: the pdf.js raster with the comments painted over it, the text
// selection, and the comment layer where every comment is selected, moved, resized, reshaped,
// edited and deleted.
//
// Translated from printcraft crates/ui-egui/src/canvas.rs (text_pointer_input,
// update_selection_on_press, update_dragged_selection, finish_text_pointer_gesture,
// paint_text_marks: selection fill #3A7BF0 at 70/255, one rect per line), canvas/selection.rs
// (Span::Run / Span::Column, click_unit), tools/comments/input.rs (page gestures: Move, Resize,
// Reshape, Draw; the 2-pixel move threshold, 4-pixel minimum size; a click selects, a double click
// opens the composer; markup tools mark a finished selection; freehand points every 1.5 pixels,
// a click a dot), tools/comments/paint.rs (hover frame, selection frame #1473E6, round white
// handles of radius 4.5) and tools/comments/geometry.rs at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt).

import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {pageText, cachedPageText} from '../../../../core/folio/model/page-text.mjs';
import {moveAnnotation, setRect, setPoints} from '../../../../core/folio/model/annots.mjs';
import {userToView, viewToUser, pageRotation, normalize} from '../../../../core/folio/lib/geom.mjs';
import {paintForm, recordAppearance, userToCanvas} from '../../../../core/folio/lib/content-paint.mjs';
import {viewText} from './viewText';
import {HANDLES, handlePos, hitComment, isMarkup, movable, pointsOf, reshapable, resizable, resized, shownOnPage, viewRects, clickUnit} from '../../../../core/folio/lib/pageview.mjs';
import {nameAt} from '../../../../core/folio/lib/cos.mjs';
import {raster, refId, type PdfSource} from './pdf';
import {FormLayer, type FormState} from './FormLayer';
import {TextEditLayer, EDIT_TOOL, ADD_TOOL, LINK_TOOL} from './TextEditLayer';
import {CameraLayer} from './CameraLayer';

export interface PageGeom { left: number; top: number; width: number; height: number; scale: number }
export type TextRun = {first: number; last: number; anchor: number; head: number} | {column: [number, number, number, number]};

export interface PageApi {
  docId: string;
  content: any;
  allowed: boolean;
  tool: string | null;
  highlighter: boolean;
  /** Run a command as the UI does (origin 'ui'); errors become a toast. */
  exec(id: string, params: Record<string, unknown>): Promise<unknown>;
  selectText(pageId: string, run: TextRun | null): void;
  selectComment(pageId: string, id: string | null): void;
  openComposer(pageId: string, id: string): void;
  scrollBy(dx: number, dy: number): void;
  rendered(index: number, ms: number): void;
  /** Form state (Prepare a form, Highlight fields, the field tool, the selected fields) and what the form layer calls. */
  form: FormState;
  sign(field: string): void;
  /** The Link tool's drag ended: Link Properties opens for the rectangle (page view points); the address is asked inside the dialog. */
  openLink(pageId: string, rect: number[]): void;
  notify(message: string): void;
  /** The find bar's matches ([page, first glyph, last glyph + 1, ...excerpt]) and the current one. */
  find: {matches: any[][]; current: number | null} | null;
  /** The Measure tool's gesture: the vertices placed, the pointer, what it snapped to and the reading so far (view points). The ref holds the latest. */
  /** Compare files: the new file's differences to shade (page index, view rect, kind, whether it is the one picked in the panel). */
  compare: {page: number; rect: number[]; kind: string; selected: boolean}[] | null;
  measure: MeasureLive | null;
  measureRef: {current: MeasureLive | null};
  setMeasure(next: MeasureLive | null): void;
  finishMeasure(live: MeasureLive): Promise<void>;
}

export interface MeasureLive {
  page: string;
  kind: 'distance' | 'perimeter' | 'area' | 'calibrate';
  points: number[][];
  hover: number[] | null;
  snap: string | null;
  reading: {label: string; angle: number; deltaX: number; deltaY: number; ratio: string} | null;
}
/** measure_ui.rs Tool: which view tool is a measure tool. */
export const measureKind = (tool: string | null): MeasureLive['kind'] | null => {
  const m = /^measure\.(distance|perimeter|area|calibrate)$/.exec(tool ?? '');
  return m ? m[1] as MeasureLive['kind'] : null;
};

const SELECT_BLUE = '#1473e6';
const DOUBLE_MS = 500, CLICK_DIST = 6;

type Gesture =
  | {kind: 'text'; anchor: number; head: number; column: [number, number, number, number] | null; clicks: number; dragged: boolean; start: [number, number]}
  | {kind: 'move'; id: string; from: [number, number]; to: [number, number]}
  | {kind: 'resize'; id: string; handle: [number, number]; from: [number, number]; to: [number, number]; rect: number[]; ratio: number | null}
  | {kind: 'reshape'; id: string; point: number; points: number[][]; to: [number, number]}
  | {kind: 'ink'; points: number[][]}
  | {kind: 'area'; from: [number, number]; to: [number, number]}
  | {kind: 'measure'; start: [number, number]; x: number; y: number}
  | {kind: 'pan'; x: number; y: number};

/** Whether pdf.js draws this record from the file (an untouched comment of a page shown once). */
export const drawnByFile = (r: any, shared: boolean) => !!r.src && !r.edited && r.ap === 'source' && !shared;

export function PageView({api, page, index, geom, source, shared, selectedId, textRun, preview}: {
  api: PageApi; page: any; index: number; geom: PageGeom; source: PdfSource | null; shared: boolean;
  selectedId: string | null; textRun: TextRun | null; preview?: {id: string; record: any} | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<{canvas: HTMLCanvasElement; key: string} | null>(null);
  const [text, setText] = useState<any>(() => cachedPageText(api.content, page));
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gref = useRef<Gesture | null>(null);
  gref.current = gesture;
  const clicks = useRef({at: 0, x: 0, y: 0, n: 0});
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState('default');
  const rotation = pageRotation(page);
  const annots: any[] = page.annots ?? [];
  const commentsLoaded = api.content?.folio === 2;

  // The file annotations pdf.js draws: untouched comments (before the comments are read, all of them).
  const shown = useMemo(() => {
    const set = new Set<string>();
    for (const r of annots) if (drawnByFile(r, shared) && shownOnPage(r)) { const id = refId(r.src); if (id) set.add(id); }
    return set;
  }, [annots, shared]);
  const shownKey = commentsLoaded ? [...shown].sort().join(',') : '*';

  // Page text: what selection, double-click and markup work on.
  useEffect(() => {
    let alive = true;
    const cached = cachedPageText(api.content, page);
    if (cached) { setText(cached); return; }
    pageText(api.content, page).then(t => { if (alive) setText(t); }).catch(() => {});
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.content.sourceBase64, page.sourceIndex, rotation]);

  // Gesture previews: the comment as it will be once the gesture is released.
  const livePreview = useMemo(() => {
    const g = gesture;
    if (!g || (g.kind !== 'move' && g.kind !== 'resize' && g.kind !== 'reshape')) return null;
    const r = annots.find(x => x.id === g.id);
    if (!r) return null;
    try {
      if (g.kind === 'move') {
        const a = viewToUser(page, g.from[0], g.from[1]), b = viewToUser(page, g.to[0], g.to[1]);
        return {id: r.id, record: moveAnnotation(r, b[0] - a[0], b[1] - a[1], {})};
      }
      if (g.kind === 'resize') {
        const v = resized(g.rect, g.handle, g.to[0] - g.from[0], g.to[1] - g.from[1], g.ratio as any);
        const a = viewToUser(page, v[0], v[1]), b = viewToUser(page, v[2], v[3]);
        return {id: r.id, record: setRect(r, normalize([a[0], a[1], b[0], b[1]]), {})};
      }
      const pts = g.points.map((p, i) => (i === g.point ? g.to : p)).map(p => viewToUser(page, p[0], p[1]));
      return {id: r.id, record: setPoints(r, pts, {})};
    } catch { return null; }
  }, [gesture, annots, page]);
  const effective = livePreview ?? preview ?? null;

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(geom.width * dpr)), H = Math.max(1, Math.round(geom.height * dpr));
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (base.current) ctx.drawImage(base.current.canvas, 0, 0, W, H);
    if (!commentsLoaded) return;
    const m = userToCanvas((x: number, y: number) => userToView(page, x, y), geom.scale * dpr);
    for (const r of annots) {
      const rec = effective && effective.id === r.id ? effective.record : r;
      if (!shownOnPage(rec)) continue;
      if (rec === r && drawnByFile(r, shared)) continue;
      const ap = recordAppearance(rec, viewText);
      if (!ap) continue;
      ctx.save();
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      try { paintForm(ctx, ap.form, ap.rect); } catch { /* a stream that can't be painted is skipped */ }
      ctx.restore();
    }
  }, [geom.width, geom.height, geom.scale, annots, effective, shared, commentsLoaded, page]);

  // The raster: re-rendered when the zoom, the turn or the file annotations shown change.
  useEffect(() => {
    if (!source) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = geom.scale * dpr;
    const key = `${scale.toFixed(4)}|${rotation}|${shownKey}|${source.uid}`;
    if (base.current?.key === key) { paint(); return; }
    const ctrl = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => {
      const shownSet = commentsLoaded ? shown : null;
      const all = shownSet ?? new Set<string>();
      const run = shownSet ? raster(source, page.sourceIndex, rotation, scale, all, ctrl.signal)
        : import('./pdf').then(({fileAnnots}) => fileAnnots(source, page.sourceIndex)).then(list => {
          for (const a of list) all.add(a.id);
          return raster(source, page.sourceIndex, rotation, scale, all, ctrl.signal);
        });
      run.then(c => { if (!ctrl.signal.aborted) { base.current = {canvas: c, key}; paint(); api.rendered(index, performance.now() - t0); } }).catch(() => {});
    }, base.current ? 60 : 0);
    paint();
    return () => { clearTimeout(timer); ctrl.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, page.sourceIndex, rotation, geom.scale, shownKey]);

  useLayoutEffect(() => { paint(); }, [paint]);

  const selected = selectedId ? annots.find(r => r.id === selectedId) ?? null : null;
  const toView = (e: {clientX: number; clientY: number}): [number, number] => {
    const b = host.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / geom.scale, (e.clientY - b.top) / geom.scale];
  };
  const screen = (v: number) => v * geom.scale;
  const selectedRect = selected ? viewRects(page, selected)[0] ?? null : null;
  const selectTool = !api.tool || api.tool === 'tool.select';
  const measureTool = measureKind(api.tool);
  const markupTool = api.tool === 'comment.highlight' || api.tool === 'comment.underline' || api.tool === 'comment.strikeout' || api.tool === 'comment.squiggly' || api.tool === 'redact.mark';

  const handleAt = (v: [number, number]): [number, number] | null => {
    // input.rs select_input / draw_grabs: the Select tool and the drawing tools pick up the handles.
    if (!selected || !selectedRect || !api.allowed || !resizable(selected) || !(selectTool || api.tool === 'comment.ink')) return null;
    const r = [selectedRect[0] - 2 / geom.scale, selectedRect[1] - 2 / geom.scale, selectedRect[2] + 2 / geom.scale, selectedRect[3] + 2 / geom.scale];
    for (const h of HANDLES) { const p = handlePos(r, h as [number, number]); if (Math.hypot(screen(p[0] - v[0]), screen(p[1] - v[1])) <= 7) return h as [number, number]; }
    return null;
  };
  const pointAt = (v: [number, number]): number | null => {
    if (!selected || !api.allowed || !reshapable(selected) || !selectTool) return null;
    const pts = pointsOf(selected).map(([x, y]: number[]) => userToView(page, x, y));
    const i = pts.findIndex(p => Math.hypot(screen(p[0] - v[0]), screen(p[1] - v[1])) <= 7);
    return i < 0 ? null : i;
  };
  const overText = (v: [number, number]) => !!text && text.glyphs.some((g: any) => v[0] >= g.rect[0] && v[0] <= g.rect[2] && v[1] >= g.rect[1] && v[1] <= g.rect[3]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const v = toView(e);
    try { host.current?.setPointerCapture(e.pointerId); } catch { /* a pointer the system does not track */ }
    (host.current?.closest('.folio-surface') as HTMLElement | null)?.focus({preventScroll: true});
    if (api.tool === 'tool.hand') { setGesture({kind: 'pan', x: e.clientX, y: e.clientY}); return; }
    // The Measure tools act on a click (measure_ui.rs page_input); a press only starts it.
    if (measureTool) { if (api.allowed) setGesture({kind: 'measure', start: v, x: e.clientX, y: e.clientY}); return; }
    const h = handleAt(v);
    if (api.tool === 'comment.ink' && !h) { if (api.allowed) setGesture({kind: 'ink', points: [v]}); return; }
    // The Redact tool: a press on text selects it (marked when it ends), a press elsewhere draws a box (redact_ui.rs page_input).
    if (api.tool === 'redact.mark' && !overText(v)) { if (api.allowed) setGesture({kind: 'area', from: v, to: v}); return; }
    // Marquee zoom: a drag anywhere on the page zooms to the rectangle (it never edits, so it needs no permission).
    if (api.tool === 'view.marquee_zoom') { setGesture({kind: 'area', from: v, to: v}); return; }
    if (h && selected && selectedRect) {
      const ratio = nameAt(selected.dict, 'Subtype') === 'Ink' && selected.dict.PCFillSign === true && selectedRect[3] > selectedRect[1]
        ? (selectedRect[2] - selectedRect[0]) / (selectedRect[3] - selectedRect[1]) : null;
      setGesture({kind: 'resize', id: selected.id, handle: h, from: v, to: v, rect: selectedRect, ratio});
      return;
    }
    const pi = pointAt(v);
    if (pi !== null && selected) {
      setGesture({kind: 'reshape', id: selected.id, point: pi, points: pointsOf(selected).map(([x, y]: number[]) => userToView(page, x, y)), to: v});
      return;
    }
    if (selectTool && commentsLoaded) {
      const hit = hitComment(page, v[0], v[1], 2 / geom.scale);
      if (hit && !isMarkup(nameAt(hit.dict, 'Subtype'))) {
        api.selectComment(page.id, hit.id);
        if (api.allowed && movable(hit)) setGesture({kind: 'move', id: hit.id, from: v, to: v});
        return;
      }
    }
    // Text selection (canvas.rs update_selection_on_press).
    const now = performance.now();
    const c = clicks.current;
    const consecutive = now - c.at <= DOUBLE_MS && Math.hypot(e.clientX - c.x, e.clientY - c.y) <= CLICK_DIST;
    c.n = consecutive ? c.n + 1 : 1;
    c.at = now; c.x = e.clientX; c.y = e.clientY;
    const n = c.n > 2 && !selectTool ? 1 : c.n;
    if (!text || !text.glyphs.length) { setGesture({kind: 'text', anchor: -1, head: -1, column: null, clicks: n, dragged: false, start: v}); return; }
    const near = text.nearest(v[0], v[1]);
    if (n >= 2 && overText(v) && near !== null) {
      const unit = clickUnit(text, n, near);
      if (unit) { setGesture({kind: 'text', anchor: unit[0], head: unit[1], column: null, clicks: n, dragged: false, start: v}); api.selectText(page.id, {first: unit[0], last: unit[1], anchor: unit[0], head: unit[1]}); return; }
    }
    setGesture({kind: 'text', anchor: near ?? -1, head: near ?? -1, column: e.altKey ? [v[0], v[1], v[0], v[1]] : null, clicks: n, dragged: false, start: v});
  }

  // The pointer with the Measure tool: where it snaps (an endpoint, midpoint, intersection, then a path; Shift keeps 45 degrees) and
  // the reading so far. One probe runs at a time; the latest pointer position waits its turn.
  const probing = useRef(false);
  const waiting = useRef<{v: [number, number]; shift: boolean} | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const probe = (v: [number, number], shift: boolean) => {
    const kind = measureKind(api.tool);
    const live = api.measureRef.current;
    const points = live && live.page === page.id && live.kind === kind ? live.points : [];
    return api.exec('measure.snap_at', {page: page.id, point: [round(v[0]), round(v[1])], pxPerPoint: geom.scale, constrain: shift && points.length > 0, ...(kind && kind !== 'calibrate' ? {kind} : {}), points}) as Promise<any>;
  };
  function hoverMeasure(v: [number, number], shift: boolean) {
    waiting.current = {v, shift};
    if (probing.current) return;
    probing.current = true;
    void (async () => {
      try {
        while (waiting.current) {
          const w = waiting.current; waiting.current = null;
          const r = await probe(w.v, w.shift);
          const kind = measureKind(api.tool);
          if (!r || !kind) continue;
          const live = api.measureRef.current;
          const points = live && live.page === page.id && live.kind === kind ? live.points : [];
          api.setMeasure({page: page.id, kind, points, hover: r.point, snap: r.snap?.kind ?? null, reading: r.reading ?? null});
        }
      } finally { probing.current = false; }
    })();
  }
  /** measure_ui.rs page_input: a click adds a vertex (or closes an area on the first one); a distance and a calibration end at two points. */
  function measureClick(v: [number, number], shift: boolean) {
    queue.current = queue.current.then(async () => {
      const kind = measureKind(api.tool);
      if (!kind) return;
      const r = await probe(v, shift);
      if (!r) return;
      const live = api.measureRef.current;
      const points = live && live.page === page.id && live.kind === kind ? live.points : [];
      const first = points[0];
      const closes = kind === 'area' && points.length >= 3 && Math.hypot(screen(first[0] - v[0]), screen(first[1] - v[1])) <= 6;
      const last = points[points.length - 1];
      const repeats = !!last && Math.hypot(last[0] - r.point[0], last[1] - r.point[1]) < 1e-6;
      const next = !closes && !repeats && points.length < 2048 ? [...points, r.point] : points;
      const state: MeasureLive = {page: page.id, kind, points: next, hover: r.point, snap: r.snap?.kind ?? null, reading: r.reading ?? null};
      if (closes || ((kind === 'distance' || kind === 'calibrate') && next.length === 2)) await api.finishMeasure(state);
      else api.setMeasure(state);
    });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const v = toView(e);
    const g = gref.current;
    if (measureTool && api.allowed) { if (!g) { setCursor('crosshair'); hoverMeasure(v, e.shiftKey); } return; }
    if (!g) { hoverAt(v); return; }
    switch (g.kind) {
      case 'pan': api.scrollBy(g.x - e.clientX, g.y - e.clientY); setGesture({...g, x: e.clientX, y: e.clientY}); break;
      case 'ink': {
        const vc: [number, number] = [Math.min(Math.max(v[0], 0), geom.width / geom.scale), Math.min(Math.max(v[1], 0), geom.height / geom.scale)];
        const last = g.points[g.points.length - 1];
        if (Math.hypot(screen(vc[0] - last[0]), screen(vc[1] - last[1])) >= 1.5) setGesture({kind: 'ink', points: [...g.points, vc]});
        break;
      }
      case 'area': setGesture({...g, to: v}); break;
      case 'move': setGesture({...g, to: v}); break;
      case 'resize': setGesture({...g, to: v}); break;
      case 'reshape': setGesture({...g, to: v}); break;
      case 'text': {
        if (!text || !text.glyphs.length) break;
        const moved = g.dragged || Math.hypot(screen(v[0] - g.start[0]), screen(v[1] - g.start[1])) > 3;
        if (!moved) break;
        if (g.column) { const col: [number, number, number, number] = [g.column[0], g.column[1], v[0], v[1]]; setGesture({...g, column: col, dragged: true}); api.selectText(page.id, {column: col}); break; }
        const hit = text.nearest(v[0], v[1]);
        if (hit === null || g.anchor < 0) break;
        let anchor = g.anchor, head = hit;
        if (g.clicks >= 2) {
          // Dragging after a double click extends by words (lines after a triple click).
          const from = clickUnit(text, g.clicks, g.anchor), to = clickUnit(text, g.clicks, hit) ?? [hit, hit];
          if (from) [anchor, head] = to[0] < from[0] ? [from[1], to[0]] : [from[0], Math.max(to[1], from[1])];
        }
        setGesture({...g, head, dragged: true});
        api.selectText(page.id, {first: Math.min(anchor, head), last: Math.max(anchor, head), anchor, head});
        break;
      }
      default: break;
    }
  }

  function hoverAt(v: [number, number]) {
    const h = handleAt(v);
    if (h) { setCursor(h[0] === 0 ? 'ns-resize' : h[1] === 0 ? 'ew-resize' : (h[0] === h[1] ? 'nwse-resize' : 'nesw-resize')); return; }
    if (api.tool === 'comment.ink') { setCursor('crosshair'); setHover(null); return; }
    if (api.tool === 'tool.hand') { setCursor('grab'); setHover(null); return; }
    if (pointAt(v) !== null) { setCursor('crosshair'); return; }
    const hit = selectTool && commentsLoaded ? hitComment(page, v[0], v[1], 2 / geom.scale) : null;
    setHover(hit?.id ?? null);
    if (hit) { setCursor(api.allowed && movable(hit) ? 'move' : 'pointer'); return; }
    setCursor(overText(v) ? 'text' : 'default');
  }

  async function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gref.current;
    setGesture(null);
    try { host.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!g) return;
    const v = toView(e);
    const addr = (id: string) => `/pg:${encodeURIComponent(page.id)}/annot:${encodeURIComponent(id)}`;
    switch (g.kind) {
      case 'measure':
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= CLICK_DIST) measureClick(g.start, e.shiftKey);
        break;
      case 'ink': {
        const pts = g.points.length ? g.points : [v];
        await api.exec('comment.ink', {page: page.id, strokes: [pts.map(p => [round(p[0]), round(p[1])])], highlighter: api.highlighter});
        break;
      }
      case 'area': {
        const x0 = Math.max(0, Math.min(g.from[0], v[0])), y0 = Math.max(0, Math.min(g.from[1], v[1]));
        const x1 = Math.min(geom.width / geom.scale, Math.max(g.from[0], v[0])), y1 = Math.min(geom.height / geom.scale, Math.max(g.from[1], v[1]));
        const rect = [round(x0), round(y0), round(x1 - x0), round(y1 - y0)];
        if (screen(x1 - x0) >= 3 && screen(y1 - y0) >= 3) await api.exec(api.tool === 'view.marquee_zoom' ? 'view.marquee_zoom' : 'redact.mark', api.tool === 'view.marquee_zoom' ? {page: page.id, rect} : {page: page.id, area: rect});
        break;
      }
      case 'move':
        if (Math.hypot(screen(g.to[0] - g.from[0]), screen(g.to[1] - g.from[1])) >= 2) await api.exec('annot.move', {annotation: addr(g.id), dx: round(g.to[0] - g.from[0]), dy: round(g.to[1] - g.from[1])});
        break;
      case 'resize': {
        const r = resized(g.rect, g.handle, g.to[0] - g.from[0], g.to[1] - g.from[1], g.ratio as any);
        if (screen(r[2] - r[0]) >= 4 && screen(r[3] - r[1]) >= 4 && (g.to[0] !== g.from[0] || g.to[1] !== g.from[1])) {
          await api.exec('annot.resize', {annotation: addr(g.id), rect: [round(r[0]), round(r[1]), round(r[2] - r[0]), round(r[3] - r[1])]});
        }
        break;
      }
      case 'reshape': {
        const from = g.points[g.point];
        if (Math.hypot(screen(g.to[0] - from[0]), screen(g.to[1] - from[1])) >= 2) {
          const pts = g.points.map((p, i) => (i === g.point ? g.to : p)).map(p => [round(p[0]), round(p[1])]);
          await api.exec('annot.reshape', {annotation: addr(g.id), points: pts});
        }
        break;
      }
      case 'text': {
        const markupId = markupTool ? api.tool : null;
        if (g.dragged) {
          if (g.column && text && !text.columnText(text.glyphsIn(g.column)).length) api.selectText(page.id, null);
          if (markupId && api.allowed) await markSelection(markupId, g);
          break;
        }
        if (g.clicks >= 2) { if (markupId && api.allowed && g.anchor >= 0) await markSelection(markupId, g); break; }
        // A plain click: a comment under it is selected (text markup included), else the selection clears.
        const hit = selectTool && commentsLoaded ? hitComment(page, v[0], v[1], 2 / geom.scale) : null;
        if (hit) { api.selectComment(page.id, hit.id); break; }
        if (e.shiftKey && textRun && 'first' in textRun && text) {
          const head = text.nearest(v[0], v[1]);
          if (head !== null) { const a = textRun.anchor; api.selectText(page.id, {first: Math.min(a, head), last: Math.max(a, head), anchor: a, head}); break; }
        }
        api.selectText(page.id, null);
        break;
      }
      default: break;
    }
  }

  async function markSelection(id: string, g: Extract<Gesture, {kind: 'text'}>) {
    if (!text) return;
    if (g.column) {
      const rects = text.glyphRects(text.glyphsIn(g.column));
      if (rects.length) await api.exec(id, {page: page.id, rects});
      api.selectText(page.id, null);
      return;
    }
    if (g.anchor < 0 || g.head < 0) return;
    let a = Math.min(g.anchor, g.head), b = Math.max(g.anchor, g.head);
    if (g.clicks >= 2 && !g.dragged) { const u = clickUnit(text, g.clicks, g.anchor); if (u) [a, b] = u; }
    const [from, to] = text.charRange(a, b);
    if (to > from) await api.exec(id, {text: `/pg:${encodeURIComponent(page.id)}/chars:${from}-${to}`});
    api.selectText(page.id, null);
  }

  function onDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    // A double click finishes a perimeter or an area (measure_ui.rs page_input).
    if (measureTool) {
      queue.current = queue.current.then(async () => {
        const live = api.measureRef.current;
        if (live && live.page === page.id && (live.kind === 'perimeter' || live.kind === 'area')) await api.finishMeasure(live);
      });
      return;
    }
    if (!selectTool || !commentsLoaded || !api.allowed) return;
    const v = toView(e);
    const hit = hitComment(page, v[0], v[1], 2 / geom.scale);
    if (hit) { api.selectComment(page.id, hit.id); api.openComposer(page.id, hit.id); }
  }

  // Overlays in CSS pixels.
  const px = (r: number[]) => ({left: r[0] * geom.scale, top: r[1] * geom.scale, width: (r[2] - r[0]) * geom.scale, height: (r[3] - r[1]) * geom.scale});
  const selectionRects: number[][] = useMemo(() => {
    if (!text || !textRun) return [];
    if ('column' in textRun) return text.glyphRects(text.glyphsIn(textRun.column));
    return text.lineRects(textRun.first, textRun.last + 1);
  }, [text, textRun]);
  // The matches of the find bar on this page (find.rs: the current one stands out).
  const findRects = useMemo(() => {
    if (!text || !api.find?.matches.length) return [] as {r: number[]; on: boolean}[];
    const cur = api.find.current === null ? null : api.find.matches[api.find.current];
    return api.find.matches.filter(m => m[0] === index).flatMap(m => text.lineRects(m[1], m[2]).map((r: number[]) => ({r, on: cur === m})));
  }, [text, api.find, index]);
  const previewRecord = livePreview?.record ?? (selected ? selected : null);
  const frame = previewRecord ? viewRects(page, previewRecord) : [];
  const markup = selected ? isMarkup(nameAt(selected.dict, 'Subtype')) : false;
  const hoverRec = hover && hover !== selectedId ? annots.find(r => r.id === hover) : null;
  const inkPts = gesture?.kind === 'ink' ? gesture.points : null;
  const areaBox = gesture?.kind === 'area' ? [Math.min(gesture.from[0], gesture.to[0]), Math.min(gesture.from[1], gesture.to[1]), Math.max(gesture.from[0], gesture.to[0]), Math.max(gesture.from[1], gesture.to[1])] : null;
  const inkWidth = api.highlighter ? 12 : 2;
  const compareMarks = useMemo(() => (api.compare ?? []).filter(m => m.page === index), [api.compare, index]);
  // The Measure tool's drawing (measure_ui.rs page_input): the vertices and the rubber band in the tool's blue, the snap in green, the reading by the pointer.
  const live = measureTool && api.measure && api.measure.page === page.id && api.measure.kind === measureTool ? api.measure : null;
  const measureOverlay = live && (live.points.length || live.hover) ? (() => {
    const BLUE = '#0078d6', GREEN = '#2e9e5c', k = geom.scale;
    const path = [...live.points, ...(live.hover && (!live.points.length || Math.hypot(live.points[live.points.length - 1][0] - live.hover[0], live.points[live.points.length - 1][1] - live.hover[1]) > 1e-6) ? [live.hover] : [])];
    const pts = path.map(p => `${p[0] * k},${p[1] * k}`).join(' ');
    return <svg className="folio-measure" width={geom.width} height={geom.height} aria-hidden="true" data-measure-points={live.points.length}>
      {path.length > 1 ? <polyline points={pts} fill="none" stroke={BLUE} strokeWidth={1.5}/> : null}
      {live.kind === 'area' && path.length > 2 ? <line x1={path[0][0] * k} y1={path[0][1] * k} x2={path[path.length - 1][0] * k} y2={path[path.length - 1][1] * k} stroke={BLUE} strokeWidth={1.5}/> : null}
      {live.kind === 'distance' && path.length === 2 ? [[path[0], path[1]], [path[1], path[0]]].map(([tip, from], i) => {
        // The open arrow the saved Line ends with (LE /OpenArrow), drawn on the line while it is placed.
        const a = Math.atan2(from[1] - tip[1], from[0] - tip[0]), len = 9, spread = 0.45;
        const barb = (t: number) => `${tip[0] * k + len * Math.cos(a + t)},${tip[1] * k + len * Math.sin(a + t)}`;
        return <polyline key={`arrow${i}`} points={`${barb(spread)} ${tip[0] * k},${tip[1] * k} ${barb(-spread)}`} fill="none" stroke={BLUE} strokeWidth={1.5}/>;
      }) : null}
      {path.map((p, i) => <circle key={i} cx={p[0] * k} cy={p[1] * k} r={3} fill={BLUE}/>)}
      {live.hover && live.snap ? <>
        <circle cx={live.hover[0] * k} cy={live.hover[1] * k} r={6} fill="none" stroke={GREEN} strokeWidth={1}/>
        <text x={live.hover[0] * k + 10} y={live.hover[1] * k - 10} fill={GREEN} fontSize={11}>{({endpoint: 'Endpoint', midpoint: 'Midpoint', intersection: 'Intersection', path: 'Path'} as Record<string, string>)[live.snap] ?? live.snap}</text>
      </> : null}
      {live.hover && live.reading && live.points.length ? <text x={live.hover[0] * k + 12} y={live.hover[1] * k + 24} fill={BLUE} fontSize={12} fontWeight={600} className="folio-measure-reading">{live.reading.label}</text> : null}
    </svg>;
  })() : null;

  return <div ref={host} className="folio-page" data-page={page.id} data-index={index} data-scale={geom.scale}
    style={{left: geom.left, top: geom.top, width: geom.width, height: geom.height, cursor: gesture?.kind === 'pan' ? 'grabbing' : cursor}}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setGesture(null)}
    onDoubleClick={onDoubleClick} onPointerLeave={() => { if (!gref.current) setHover(null); }}>
    <canvas ref={canvas} className="folio-page-canvas" style={{width: geom.width, height: geom.height}} aria-hidden="true"/>
    {selectionRects.length ? <div className="folio-selection" aria-hidden="true">
      {selectionRects.map((r, i) => <i key={i} style={px(r)}/>)}
      {textRun && 'column' in textRun && gesture?.kind === 'text' ? <b style={px(normalize(textRun.column))}/> : null}
    </div> : null}
    {findRects.length ? <div className="folio-find" aria-hidden="true">{findRects.map((m, i) => <i key={i} className={m.on ? 'is-current' : undefined} style={px(m.r)}/>)}</div> : null}
    {hoverRec ? <div className="folio-comment-hover" aria-hidden="true">{viewRects(page, hoverRec).map((r, i) => <i key={i} style={px([r[0] - 2 / geom.scale, r[1] - 2 / geom.scale, r[2] + 2 / geom.scale, r[3] + 2 / geom.scale])}/>)}</div> : null}
    {selected && frame.length ? <div className="folio-comment-selected" data-annot={selected.id} aria-hidden="true">
      {markup ? frame.map((r, i) => <i key={i} className="is-quad" style={px([r[0] - 2 / geom.scale, r[1] - 2 / geom.scale, r[2] + 2 / geom.scale, r[3] + 2 / geom.scale])}/>)
        : reshapable(selected) && api.allowed && selectTool
          ? (gesture?.kind === 'reshape' ? gesture.points.map((p, i) => (i === gesture.point ? gesture.to : p)) : pointsOf(previewRecord).map(([x, y]: number[]) => userToView(page, x, y)))
            .map((p: number[], i: number) => <u key={i} className="is-point" style={{left: p[0] * geom.scale, top: p[1] * geom.scale}}/>)
          : (() => {
            const r = frame[0];
            const rr = [r[0] - 2 / geom.scale, r[1] - 2 / geom.scale, r[2] + 2 / geom.scale, r[3] + 2 / geom.scale];
            return <>
              <i style={px(rr)}/>
              {api.allowed && resizable(selected) ? HANDLES.map(h => { const p = handlePos(rr, h as [number, number]); return <u key={h.join()} style={{left: p[0] * geom.scale, top: p[1] * geom.scale}}/>; }) : null}
            </>;
          })()}
    </div> : null}
    {commentsLoaded && (api.content?.fields?.length || api.form.tool) ? <FormLayer api={api} page={page} geom={geom} form={api.form} fields={api.content.fields ?? []}/> : null}
    {api.tool === EDIT_TOOL || api.tool === ADD_TOOL || api.tool === LINK_TOOL ? <TextEditLayer api={api} page={page} geom={geom}/> : null}
    {api.tool === 'ocr.enhance_camera' ? <CameraLayer api={api} page={page} geom={geom}/> : null}
    {areaBox ? <div className="folio-redact-box" aria-hidden="true" style={px(areaBox)}/> : null}
    {compareMarks.length ? <div className="folio-compare" aria-hidden="true">{compareMarks.map((m, i) => <i key={i} data-kind={m.kind} className={m.selected ? 'is-selected' : undefined} style={px(m.rect)}/>)}</div> : null}
    {measureOverlay}
    {inkPts ? <svg className="folio-ink-preview" width={geom.width} height={geom.height} aria-hidden="true">
      <polyline points={inkPts.map(p => `${p[0] * geom.scale},${p[1] * geom.scale}`).join(' ')} fill="none" strokeLinecap="round" strokeLinejoin="round"
        stroke={api.highlighter ? 'rgba(255, 240, 0, 1)' : '#0066de'} strokeWidth={inkWidth * geom.scale} style={api.highlighter ? {mixBlendMode: 'multiply'} : undefined}/>
    </svg> : null}
  </div>;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
export {SELECT_BLUE};
