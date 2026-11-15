// The slide canvas of Normal view: the current slide centred in the window (fit with a 28 pt
// margin, or the zoom percent), pointer input routed to the translated pointer tools, and the
// overlays deckcraft draws over the slide: selection boxes, the eight resize handles, the rotate
// handle on its stem, yellow adjust handles, glued line ends, a dashed box around text being
// edited with its caret and selected text, smart guides, the marquee, the drawing preview,
// connection sites, freeform and ink previews, drawing guides and gridlines.
// Follows deckcraft crates/ui-egui/src/canvas.rs (layout: margin 28, fit, zoom), canvas/input.rs
// (event mapping: press → down, drag → drag, release → up, the second release of a double click →
// doubleClick, the third → tripleClick, a right press → contextClick; hit tolerance 4 screen px),
// canvas/overlays.rs (selection_handles, overlays, rotate_handle, draw_preview) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. F:prism surface.
//
// While the button is down the gesture runs locally on a PointerSession (the same code the
// command runs) and the canvas paints its result; on release the whole gesture goes to the
// `surface.pointer` command, which replays it on the document as one undo step.

import {Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import * as pointerLib from '../../../../core/prism/lib/pointer.mjs';
import {planKey, planTyping} from '../../../../core/prism/lib/keys.mjs';
import {boxOf} from '../../../../core/prism/lib/connect.mjs';
import * as pointsLib from '../../../../core/prism/lib/points.mjs';
import {selectedShapeIds, textSelection, shapeChain, slideById, slideSizeOf} from '../../../../core/prism/model/doc.mjs';
import {findShape, isLine} from '../../../../core/prism/model/presentation.mjs';
import {ctxForSlide} from '../../../../core/prism/model/resolve.mjs';
import * as renderLib from '../../../../core/prism/model/render.mjs';
import {layoutText, lineAt, caretX} from '../../../../core/prism/model/textlayout.mjs';
import {posOf} from '../../../../core/prism/model/text.mjs';
import {xfrmAffine, groupChildAffine} from '../../../../core/prism/model/geom/index.mjs';
import {apply, affChain, affTranslate, affRotate, affScaleXY, affDeterminant, IDENTITY} from '../../../../core/prism/model/geom/kurbo.mjs';
import {chordFromEvent, chordText} from '../../../shell/keys/KeyRouter';
import {platform} from '../../../shell/env';
import {cellSelection, cellBlock} from '../../../../core/prism/lib/table-sel.mjs';
import {drawnHeights as tableDrawnHeights, resolveStyle as tableStyleOf, cellRects as tableCellRects, cellBody as tableCellBody, cellShape as tableCellShape} from '../../../../core/prism/model/table-style.mjs';
import {SlideView, LAYOUT_OPTS} from './SlideView';
import {spelling, watchSession, sessionKey} from '../../../../core/common/lib/spelling.mjs';
import {spellingIssues} from '../../../../core/prism/lib/spelling-issues.mjs';
import {setSquiggleHit} from './proof-store';
import {MediaLayer} from './MediaLayer';
import {applyPicks} from '../lib/colorAt';

// The previews play through the show's engine (src/apps/prism/show/ShowStage.tsx), loaded when first used.
const ShowStage = lazy(() => import('../show/ShowStage'));

type Any = any;
const {PointerSession, boxHandles, newToolState, isFreeformTool} = pointerLib as Any;
const shapeGeometry: (sh: Any, w: number, h: number) => Any = (renderLib as Any).shapeGeometry;
type Controller = SurfaceProps['controller'];
const MARGIN = 28;
const HANDLE_R = 4.5;
const DOUBLE_MS = 500;

interface Gesture { session: Any; events: Any[]; pending: 'double' | 'triple' | null; tol: number }
interface Preview { content: Any; selection: Any; tool: Any }

const mods = (e: {shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean}) => ({shift: e.shiftKey, alt: e.altKey, cmd: platform() === 'mac' ? e.metaKey : e.ctrlKey});

/** Shape-local → slide affine for any shape (through its groups) and its box. */
function placed(content: Any, slide: Any, id: string): {m: number[]; x: Any; sh: Any} | null {
  const chain = shapeChain(slide, id);
  if (!chain) return null;
  let m: number[] = IDENTITY as Any;
  let list = slide.shapes;
  for (let k = 0; k < chain.length; k++) {
    const sh = list.find((s: Any) => s.id === chain[k]);
    if (!sh) return null;
    const x = k === 0 ? boxOf(content, slide, sh) : sh.xfrm ?? {x: 0, y: 0, w: 0, h: 0};
    if (k === chain.length - 1) return {m: affChain(m, xfrmAffine(x)), x, sh};
    const c = sh.kind?.child ?? {x: 0, y: 0, w: x.w, h: x.h};
    m = affChain(m, groupChildAffine(x, {x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h}));
    list = sh.kind?.children ?? [];
  }
  return null;
}

export function SlideCanvas({controller, docId, content, selection, view, slide, onActivate}: {
  controller: Controller; docId: string; content: Any; selection: Any; view: Any; slide: Any; onActivate: () => void;
}) {
  const session = controller.session;
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [box, setBox] = useState({w: 800, h: 500});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hover, setHover] = useState<Any>(null);
  const gesture = useRef<Gesture | null>(null);
  const lastPress = useRef({t: 0, x: 0, y: 0, n: 0});
  const frame = useRef(0);
  // The Draw tab's Ruler stencil: dragged with the pointer (kept in the view on release) and turned with the wheel.
  const rulerDrag = useRef<{gx: number; gy: number} | null>(null);
  const [rulerLive, setRulerLive] = useState<Any>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setBox({w: el.clientWidth, h: el.clientHeight});
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = slideSizeOf(content, slide);
  const fitting = !(Number.isFinite(view?.zoom)) || view?.fit === 'fit' || (view?.fit && view.fit !== null);
  const fit = Math.max(Math.min((box.w - MARGIN * 2) / size.width, (box.h - MARGIN * 2) / size.height), 0.05);
  const scale = fitting ? fit : Math.min(Math.max(view.zoom / 100, 0.1), 5);
  const stageW = Math.max(box.w, size.width * scale + MARGIN * 2), stageH = Math.max(box.h, size.height * scale + MARGIN * 2);
  const ox = Math.max(MARGIN, (stageW - size.width * scale) / 2), oy = Math.max(MARGIN, (stageH - size.height * scale) / 2);
  const tol = 4 / scale;

  const shown = preview ?? {content, selection, tool: null};
  const shownSlide = slideById(shown.content, slide.id) ?? slide;

  // Opening a presentation fits the slide to the window (deckcraft: zoom None = fit).
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    if (view?.fit == null && view?.zoom === 100 && controller.hasCommand('view.zoom')) void controller.run('view.zoom', {value: 'fit'}).catch(() => {});
  }, [controller, view]);

  const toSlide = useCallback((e: {clientX: number; clientY: number}) => {
    const r = scroller.current!.getBoundingClientRect();
    const sx = e.clientX - r.left + scroller.current!.scrollLeft, sy = e.clientY - r.top + scroller.current!.scrollTop;
    return {x: (sx - ox) / scale, y: (sy - oy) / scale};
  }, [ox, oy, scale]);

  const newSession = useCallback((tool?: Any) => {
    let snap: Preview | null = null;
    const io = {
      read: () => { const d = session.get(docId); return snap ?? {content: d.file.content, selection: d.selection}; },
      write: (c: Any, sel: Any) => { snap = {content: c, selection: sel, tool: null}; },
      has: (id: string) => controller.hasCommand(id),
    };
    const d = session.get(docId);
    return new PointerSession({io, view: d.view ?? {}, prefs: session.prefs, tool: tool ?? newToolState(d.view ?? {}), ...LAYOUT_OPTS});
  }, [session, docId, controller]);

  const paint = useCallback((s: Any) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      s.flush?.();
      const {content: c, selection: sel} = s.io.read();
      setPreview({content: s.content ?? c, selection: sel, tool: {...s.tool}});
    });
  }, []);

  const commit = useCallback(async (g: Gesture) => {
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    try {
      const r: Any = await controller.run('surface.pointer', {events: g.events, tol: g.tol}, {origin: 'ui'});
      const ui = r?.result?.ui ?? [];
      if (ui.some((u: Any) => u.pane === 'format') && controller.paneSpec('format')) controller.setPane('format', true);
      await applyPicks(controller, docId, ui);
    } catch (e: Any) {
      controller.notify(String(e?.message ?? e), 'error');
    } finally {
      setPreview(null);
    }
  }, [controller]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    onActivate();
    input.current?.focus({preventScroll: true});
    const p = toSlide(e);
    const now = performance.now();
    const lp = lastPress.current;
    const n = e.button === 0 && now - lp.t < DOUBLE_MS && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 5 ? lp.n + 1 : 1;
    lastPress.current = {t: now, x: e.clientX, y: e.clientY, n: e.button === 0 ? n : 0};
    const m = mods(e);
    const rs = e.button === 0 ? rulerPart(view, p, view?.tool?.kind === 'ink' && view.tool.mode !== 'eraser') : null;
    if (rs === 'body') {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      rulerDrag.current = {gx: p.x - view.rulerStencil.x, gy: p.y - view.rulerStencil.y};
      setRulerLive({...view.rulerStencil});
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      void commit({session: null, events: [{kind: 'contextClick', ...p, mods: m}], pending: null, tol});
      return;
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const s = newSession();
    const ev = {kind: 'down', ...p, mods: m, tol, pressure: e.pointerType === 'pen' ? e.pressure : undefined};
    s.pointer(ev);
    gesture.current = {session: s, events: [ev], pending: n === 2 ? 'double' : n >= 3 ? 'triple' : null, tol};
    paint(s);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toSlide(e);
    if (rulerDrag.current) { setRulerLive({...view.rulerStencil, x: p.x - rulerDrag.current.gx, y: p.y - rulerDrag.current.gy}); return; }
    const g = gesture.current;
    if (g) {
      const ev = {kind: 'drag', ...p, mods: mods(e), tol, pressure: e.pointerType === 'pen' ? e.pressure : undefined};
      g.events.push(ev);
      g.session.pointer(ev);
      paint(g.session);
      return;
    }
    // Hover: the cursor, and a freeform's rubber band.
    const s = newSession();
    s.pointer({kind: 'move', ...p, mods: mods(e), tol});
    setHover({hit: s.tool.hover, guide: s.tool.guideHover, tool: s.tool.kind, path: s.tool.pathPreview, closing: s.tool.pathClosing, smooth: s.tool.pathSmooth,
      sites: s.tool.sites, glue: s.tool.glue, seg: s.tool.hoverSegment});
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (rulerDrag.current) {
      const p = toSlide(e), d = rulerDrag.current;
      rulerDrag.current = null;
      setRulerLive(null);
      void controller.run('draw.ruler', {x: p.x - d.gx, y: p.y - d.gy}, {origin: 'ui'}).catch(() => {});
      return;
    }
    const g = gesture.current;
    if (!g || e.button !== 0) return;
    const p = toSlide(e);
    const kind = g.pending === 'double' ? 'doubleClick' : g.pending === 'triple' ? 'tripleClick' : 'up';
    g.events.push({kind, ...p, mods: mods(e), tol});
    void commit(g);
  };

  // The wheel over the ruler turns it (5 degrees a notch; Shift 1).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      const r = view?.rulerStencil;
      if (!r || r.on === false) return;
      const p = toSlide(e);
      if (rulerPart(view, p, false) !== 'body') return;
      e.preventDefault();
      void controller.run('draw.ruler', {angle: (r.angle ?? 0) + (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 1 : 5)}, {origin: 'ui'}).catch(() => {});
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [view, toSlide, controller]);

  // Keyboard: deckcraft engine keys first (text editing, nudges, Tab), the registry's shortcuts after.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement !== input.current || e.isComposing || e.defaultPrevented) return;
      const d = (() => { try { return session.get(docId); } catch { return null; } })();
      if (!d) return;
      const m = mods(e);
      const plan: Any = planKey(d.file.content, d.selection, e.key, m, {mac: platform() === 'mac', drawingFreeform: !!d.view?.toolDrag});
      if (plan.handled) {
        e.preventDefault();
        if (plan.finishFreeform) {
          const pts = (d.view as Any)?.toolDrag?.points ?? [];
          const last = pts[pts.length - 1];
          if (last) void commit({session: null, events: [{kind: 'doubleClick', x: last.x, y: last.y, mods: {}}], pending: null, tol});
          return;
        }
        if (plan.select) { session.setSelection(docId, plan.select, {origin: 'ui'}); return; }
        void runSteps(controller, plan.steps ?? []);
        return;
      }
      // Ctrl shortcuts (and the rest) go to the shell's KeyRouter even though the input owns typing.
      const chord = chordFromEvent(e as Any);
      if (!chord || (!m.cmd && !m.alt && e.key.length === 1)) return;
      const r: Any = controller.key(chordText(chord, platform()));
      if (Array.isArray(r) ? r.some((x: Any) => x.handled) : r?.handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session, docId, controller, commit, tol]);

  const typeText = (text: string, commitIme: boolean) => {
    if (!text) return;
    const d = session.get(docId);
    const steps: Any = planTyping(d.file.content, d.selection, text, {commit: commitIme});
    if (steps) void runSteps(controller, steps);
  };

  const sel = useMemo(() => ({shapes: selectedShapeIds(shown.content, shown.selection), text: textSelection(shown.content, shown.selection), cells: cellSelection(shown.content, shown.selection)}), [shown.content, shown.selection]);
  const tool = preview?.tool ?? null;
  const cursor = cursorFor(hover, tool ?? hover);
  // Animations tab or Animation Pane open: each animated shape carries its number (PowerPoint's tags).
  const shell = useSyncExternalStore(controller.subscribe, controller.getState);
  const tags = shell.tab === 'animations' || shell.panes.some((p: Any) => p.id === 'animation' && p.open);
  const tp = view?.transitionPreview?.on ? view.transitionPreview : null;
  const ap = view?.animPreview?.on ? view.animPreview : null;
  const slideIndex = (content.slides ?? []).findIndex((s: Any) => s.id === slide.id);
  // Spelling squiggles under the misspelt words of the slide (the word the caret is in is left alone); the Spelling pane lists the same issues.
  const sp = spelling();
  const proofVersion = useSyncExternalStore(useCallback((f: () => void) => sp.subscribe(f), [sp]), () => sp.version);
  useEffect(() => { sp.setUserWords((session.prefs as Any).userDictionary); }, [sp, session.prefs]);
  useEffect(() => { watchSession(session); }, [session]);
  const caret: Any = (() => {
    const t = sel.text;
    if (!t || t.notes) return null;
    const sh: Any = findShape(slide.shapes ?? [], t.shape);
    const body = t.cell ? sh?.kind?.rows?.[t.cell[0]]?.cells?.[t.cell[1]]?.text : sh?.text;
    if (!body) return null;
    const [cp, cc] = posOf(body, Math.min(t.caret, 1e9));
    return {shape: t.shape, cell: t.cell ?? null, para: cp, off: cc};
  })();
  const caretKey = caret ? `${caret.shape}/${caret.cell?.join(',') ?? ''}/${caret.para}/${caret.off}` : '';
  const marks = useMemo(() => {
    if (view?.master || slideIndex < 0 || (session.prefs as Any).checkSpelling === false) return [];
    try { return squiggleMarks(content, slide, spellingIssues(content, undefined, [], {sp, session: sessionKey((session as Any).host, docId), slide: slideIndex, caret})); } catch { return []; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, slide, slideIndex, proofVersion, caretKey, view?.master]);
  useEffect(() => {
    setSquiggleHit(docId, (cx: number, cy: number) => squiggleAt(marks, toSlide({clientX: cx, clientY: cy}), tol));
    return () => setSquiggleHit(docId, null);
  }, [docId, marks, toSlide, tol]);
  const stop = (cmd: string) => () => { void controller.run(cmd, {on: false}, {origin: 'ui'}).catch(() => {}); };

  return <div className="prism-canvas" ref={scroller} onContextMenu={e => e.preventDefault()} data-zoom={Math.round(scale * 100)}>
    <div className="prism-stage" style={{width: stageW, height: stageH, cursor}} data-context={hover?.hit?.kind === 'vertex' ? 'edit-points-vertex' : hover?.seg ? 'edit-points-segment' : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { gesture.current = null; setPreview(null); }}>
      <div className="prism-slide-frame" style={{left: ox, top: oy, width: size.width * scale, height: size.height * scale}}>
        <SlideView content={shown.content} slide={shownSlide} editor hideInk={!!view?.hideInk} className="prism-slide-svg"/>
        <MediaLayer content={shown.content} slide={shownSlide} scale={scale} mode="edit" request={view?.mediaRequest ?? null}
          onReport={r => { void controller.run('media.report', r, {origin: 'ui'}).catch(() => {}); }}
          onFrame={(id, data) => { void controller.run('media.posterFrame', {id, data}, {origin: 'ui'}).catch(() => {}); }}/>
        {tp ? <Suspense fallback={null}><ShowStage key={`t${tp.n}`} content={content} mode="transition" from={slideIndex} embedded onExit={stop('transition.preview')}/></Suspense> : null}
        {ap ? <Suspense fallback={null}><ShowStage key={`a${ap.n}`} content={content} mode="animation" from={slideIndex} playFrom={ap.from} embedded onExit={stop('animation.preview')}/></Suspense> : null}
      </div>
      <Overlay content={shown.content} slide={shownSlide} sel={sel} tool={tool} hover={hover} view={view} ox={ox} oy={oy} scale={scale} w={stageW} h={stageH} tags={tags && !tp && !ap} squiggles={marks} stencil={rulerLive ?? (view?.rulerStencil?.on === false ? null : view?.rulerStencil ?? null)}/>
      <textarea ref={input} className="prism-input" aria-label="Slide" spellCheck={false} autoComplete="off"
        onInput={e => { const t = e.currentTarget; if ((e.nativeEvent as Any).isComposing) return; const v = t.value; t.value = ''; typeText(v, false); }}
        onCompositionEnd={e => { const t = e.currentTarget; t.value = ''; typeText(e.data, true); }}/>
    </div>
  </div>;
}

async function runSteps(controller: Controller, steps: {command: string; params: Any}[]) {
  for (const st of steps) {
    if (!controller.hasCommand(st.command)) return;
    try { await controller.run(st.command, st.params, {origin: 'shortcut'}); } catch (e: Any) { controller.notify(String(e?.message ?? e), 'error'); return; }
  }
}

const RESIZE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
function cursorFor(hover: Any, tool: Any): string {
  const k = tool?.tool?.kind ?? tool?.kind?.kind ?? hover?.tool?.kind;
  if (k === 'shape' || k === 'textBox' || k === 'lasso') return 'crosshair';
  if (k === 'ink' || k === 'eyedropper') return 'crosshair';
  const h = hover?.hit;
  if (!h) return hover?.guide != null ? 'move' : 'default';
  if (h.kind === 'resize') return RESIZE_CURSORS[h.handle] ?? 'default';
  if (h.kind === 'rotate') return 'grab';
  if (h.kind === 'adjust' || h.kind === 'lineEnd' || h.kind === 'vertex' || h.kind === 'handle') return 'pointer';
  if (h.kind === 'frame') return 'move';
  if (h.kind === 'tableColumn') return 'col-resize';
  if (h.kind === 'tableRow') return 'row-resize';
  if (h.kind === 'shape') return h.text ? 'text' : 'move';
  return 'default';
}

/** Where a point is on the ruler stencil (view.rulerStencil: 520 x 70 pt, top left corner and angle): its body (drag it), or null; with a pen armed the strip along its top edge draws instead. */
function rulerPart(view: Any, p: {x: number; y: number}, penArmed: boolean): 'body' | null {
  const r = view?.rulerStencil;
  if (!r || r.on === false || !Number.isFinite(r.x) || !Number.isFinite(r.y)) return null;
  const a = ((r.angle ?? 0) * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
  const along = (p.x - r.x) * ux + (p.y - r.y) * uy, dist = -(p.x - r.x) * uy + (p.y - r.y) * ux;
  if (along < 0 || along > 520 || dist < 0 || dist > 70) return null;
  return penArmed && dist <= 14 ? null : 'body';
}

/** The ruler stencil drawn over the slide: a translucent band with a tick every eighth inch and a number every inch along its top edge. */
function rulerStencilArt(r: Any, S: (p: {x: number; y: number}) => {x: number; y: number}, scale: number) {
  const o = S({x: r.x, y: r.y});
  const ticks: React.ReactNode[] = [];
  for (let k = 0; k * 9 <= 520; k++) {
    const x = k * 9, big = k % 8 === 0, mid = k % 4 === 0;
    ticks.push(<line key={`t${k}`} x1={x} x2={x} y1={0} y2={big ? 14 : mid ? 10 : 6} className="prism-stencil-tick"/>);
    if (big && k > 0) ticks.push(<text key={`n${k}`} x={x + 2} y={26} className="prism-stencil-num">{k / 8}</text>);
  }
  return <g key="stencil" className="prism-stencil" data-stencil="ruler" transform={`translate(${o.x} ${o.y}) rotate(${r.angle ?? 0}) scale(${scale})`}>
    <rect width={520} height={70} rx={4} className="prism-stencil-body"/>{ticks}
    <text x={260} y={52} textAnchor="middle" className="prism-stencil-angle">{Math.round(((r.angle ?? 0) + 540) % 360 - 180) === 0 ? '0°' : `${Math.round(r.angle ?? 0)}°`}</text>
  </g>;
}

/** Overlays in screen pixels over the stage. */
function Overlay({content, slide, sel, tool, hover, view, ox, oy, scale, w, h, tags, squiggles, stencil}: Any) {
  const S = (p: {x: number; y: number}) => ({x: ox + p.x * scale, y: oy + p.y * scale});
  const out: React.ReactNode[] = [];
  const size = slideSizeOf(content, slide);
  // Gridlines and drawing guides (View › Gridlines, View › Guides).
  if (view?.gridlines) {
    const step = Math.max(Number((content as Any).gridSpacing ?? 0) || 0, 0) || 36;
    for (let x = step; x < size.width; x += step) out.push(<line key={`gx${x}`} className="prism-grid" x1={ox + x * scale} y1={oy} x2={ox + x * scale} y2={oy + size.height * scale}/>);
    for (let y = step; y < size.height; y += step) out.push(<line key={`gy${y}`} className="prism-grid" x1={ox} y1={oy + y * scale} x2={ox + size.width * scale} y2={oy + y * scale}/>);
  }
  if (view?.guides) {
    (content.guides ?? []).forEach((g: Any, i: number) => {
      const pos = tool?.guideDrag && tool.guideDrag[0] === i ? tool.guideDrag[1] : g.pos;
      out.push(g.vertical ? <line key={`dg${i}`} className="prism-drawguide" x1={ox + pos * scale} y1={oy} x2={ox + pos * scale} y2={oy + size.height * scale}/>
        : <line key={`dg${i}`} className="prism-drawguide" x1={ox} y1={oy + pos * scale} x2={ox + size.width * scale} y2={oy + pos * scale}/>);
    });
  }
  // The rulers (View › Ruler): inches from the slide's top left, a tick every eighth, a number every inch.
  if (view?.ruler) {
    const eighth = 9 * scale;
    const label = eighth >= 4;
    for (let k = 0; k * 9 <= size.width; k++) {
      const x = ox + k * eighth, big = k % 8 === 0, mid = k % 4 === 0;
      if (!label && !big) continue;
      out.push(<line key={`rx${k}`} className="prism-ruler" x1={x} x2={x} y1={oy - 3 - (big ? 10 : mid ? 7 : 4)} y2={oy - 3}/>);
      if (big && k > 0) out.push(<text key={`rxt${k}`} className="prism-ruler-text" x={x + 2} y={oy - 9}>{k / 8}</text>);
    }
    for (let k = 0; k * 9 <= size.height; k++) {
      const y = oy + k * eighth, big = k % 8 === 0, mid = k % 4 === 0;
      if (!label && !big) continue;
      out.push(<line key={`ry${k}`} className="prism-ruler" y1={y} y2={y} x1={ox - 3 - (big ? 10 : mid ? 7 : 4)} x2={ox - 3}/>);
      if (big && k > 0) out.push(<text key={`ryt${k}`} className="prism-ruler-text" x={ox - 21} y={y + 3}>{k / 8}</text>);
    }
    out.push(<line key="r0x" className="prism-ruler" x1={ox} x2={ox + size.width * scale} y1={oy - 3} y2={oy - 3}/>, <line key="r0y" className="prism-ruler" x1={ox - 3} x2={ox - 3} y1={oy} y2={oy + size.height * scale}/>);
  }
  if (stencil) out.push(rulerStencilArt(stencil, S, scale));
  if (tags) out.push(...animationTags(content, slide, view, S));
  const editing = sel.text && !sel.text.notes ? sel.text : null;
  // Table Layout › View Gridlines: every cell edge of every table as a dotted line; the selected range of cells shaded.
  if (view?.tableGridlines || sel.cells) out.push(...tableMarks(content, slide, sel, !!view?.tableGridlines, S));
  for (const id of sel.shapes) {
    const pl = placed(content, slide, id);
    if (!pl) continue;
    const {x, sh} = pl;
    const a = pl.m;
    const corners = [[0, 0], [x.w, 0], [x.w, x.h], [0, x.h]].map(([px, py]) => S(apply(a, {x: px, y: py})));
    if (isLine(sh)) {
      const glued = sh.kind?.type === 'connector' ? [!!sh.kind.start, !!sh.kind.end] : [false, false];
      [S(apply(a, {x: 0, y: 0})), S(apply(a, {x: x.w, y: x.h}))].forEach((q, i) => out.push(<circle key={`le${id}${i}`} className={`prism-handle${glued[i] ? ' is-glued' : ''}`} cx={q.x} cy={q.y} r={HANDLE_R}/>));
      continue;
    }
    // Edit Points: the outline's vertices and the handles of the chosen one stand in for the box's handles.
    const ed = tool?.editPoints ?? view?.editPoints ?? null;
    if (ed && String(ed.id) === String(id) && sel.shapes.length === 1 && !editing && sh.geom?.kind === 'custom') {
      pointsLib.slideVertices(sh, x).forEach((vs: Any[], pi: number) => vs.forEach((q: Any, i: number) => {
        const sp = S(q), chosen = ed.vertex?.[0] === pi && ed.vertex?.[1] === i;
        out.push(<rect key={`pv${pi}-${i}`} className={`prism-vertex${chosen ? ' is-chosen' : ''}`} x={sp.x - 4} y={sp.y - 4} width={8} height={8} data-vertex={`${pi}:${i}`}/>);
      }));
      const hs = ed.vertex ? pointsLib.slideHandles(sh, x, ed.vertex[0], ed.vertex[1]) : null;
      if (hs) {
        const v = S(hs.v);
        for (const [q, nm] of [[hs.hin, 'in'], [hs.hout, 'out']] as [Any, string][]) {
          if (!q) continue;
          const hp = S(q);
          out.push(<line key={`phl${nm}`} className="prism-handle-line" x1={v.x} y1={v.y} x2={hp.x} y2={hp.y}/>, <circle key={`ph${nm}`} className="prism-handle-dot" cx={hp.x} cy={hp.y} r={4} data-handle={nm}/>);
        }
      }
      continue;
    }
    const editingThis = !!editing && editing.shape === id;
    out.push(<polygon key={`sb${id}`} className={`prism-selbox${editingThis ? ' is-editing' : ''}`} points={corners.map(c => `${c.x},${c.y}`).join(' ')}/>);
    if (sh.locked && !editingThis) {
      boxHandles(x).pts.forEach((q: Any, i: number) => { const s = S(q); out.push(<circle key={`lk${id}${i}`} className="prism-handle is-locked" cx={s.x} cy={s.y} r={4}/>); });
      continue;
    }
    if (sel.shapes.length === 1 || !editingThis) {
      const {pts, rot} = boxHandles(x);
      if (!editingThis) {
        const top = S(pts[1]), r = S(rot);
        out.push(<line key={`rs${id}`} className="prism-selline" x1={top.x} y1={top.y} x2={r.x} y2={r.y}/>);
        out.push(<g key={`rh${id}`} className="prism-rotate" transform={`translate(${r.x} ${r.y})`}><circle r={6}/>
          <path d={arcPath(4)}/></g>);
      }
      pts.forEach((q: Any, i: number) => { const s = S(q); out.push(<circle key={`h${id}${i}`} className="prism-handle" cx={s.x} cy={s.y} r={HANDLE_R}/>); });
      for (const hd of shapeGeometry(sh, x.w, x.h).handles ?? []) {
        const s = S(apply(a, hd.pos));
        out.push(<circle key={`a${id}${hd.index}`} className="prism-adjust" cx={s.x} cy={s.y} r={HANDLE_R}/>);
      }
    }
  }
  for (const [i, m] of ((squiggles ?? []) as SquiggleMark[]).entries()) { const d = squigglePath(m, S, scale); if (d) out.push(<path key={`sq${i}`} className="prism-squiggle" d={d} data-spelling-word={m.issue.word}/>); }
  if (editing) out.push(...textMarks(content, slide, editing, S, scale));
  // Smart guides, marquee, previews.
  for (const [i, g] of (tool?.guides ?? []).entries()) {
    const [p0, p1] = g.vertical ? [{x: g.pos, y: g.from}, {x: g.pos, y: g.to}] : [{x: g.from, y: g.pos}, {x: g.to, y: g.pos}];
    const a = S(p0), b = S(p1);
    out.push(<line key={`sg${i}`} className="prism-smartguide" x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>);
  }
  if (tool?.marquee) {
    const a = S({x: tool.marquee.x0, y: tool.marquee.y0}), b = S({x: tool.marquee.x1, y: tool.marquee.y1});
    out.push(<rect key="mq" className="prism-marquee" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y}/>);
  }
  if (tool?.preview) {
    const p = tool.preview;
    const a = S({x: p.x, y: p.y}), b = S({x: p.x + p.w, y: p.y + p.h});
    const lineTool = tool.kind?.kind === 'shape' && /line|Connector/i.test(tool.kind.preset ?? '') && !isFreeformTool(tool.kind.preset);
    if (lineTool) {
      const [s0, s1] = [p.flipH ? b.x : a.x, p.flipV ? b.y : a.y], [e0, e1] = [p.flipH ? a.x : b.x, p.flipV ? a.y : b.y];
      out.push(<line key="pv" className="prism-preview" x1={s0} y1={s1} x2={e0} y2={e1}/>);
    } else out.push(<rect key="pv" className="prism-preview" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y}/>);
  }
  const path = tool?.pathPreview?.length ? tool.pathPreview : hover?.path;
  if (path && path.length > 1) {
    out.push(<polyline key="ff" className="prism-freeform" points={path.map((q: Any) => { const s = S(q); return `${s.x},${s.y}`; }).join(' ')}/>);
    if (tool?.pathClosing ?? hover?.closing) { const s = S(path[0]); out.push(<circle key="ffc" className="prism-glue" cx={s.x} cy={s.y} r={5}/>); }
  }
  for (const [i, q] of ((tool?.sites?.length ? tool.sites : hover?.sites) ?? []).entries()) { const s = S(q); out.push(<circle key={`st${i}`} className="prism-handle" cx={s.x} cy={s.y} r={3.5}/>); }
  const glue = tool?.glue ?? hover?.glue;
  if (glue) { const s = S(glue); out.push(<circle key="gl" className="prism-glue" cx={s.x} cy={s.y} r={5}/>); }
  if (tool?.inkPreview?.length > 1 && tool.kind?.kind === 'ink') {
    out.push(<polyline key="ink" fill="none" stroke={inkColor(tool.kind.color)} strokeOpacity={tool.kind.mode === 'highlighter' ? 0.45 : 1}
      strokeWidth={Math.max(tool.kind.width * scale, 1)} strokeLinecap="round" strokeLinejoin="round"
      points={tool.inkPreview.map((q: number[]) => { const s = S({x: q[0], y: q[1]}); return `${s.x},${s.y}`; }).join(' ')}/>);
  }
  return <svg className="prism-overlay" width={w} height={h} aria-hidden="true">{out}</svg>;
}

/**
 * The numbers on animated shapes (PowerPoint: the tags beside each effect while the Animations tab or the pane is up): the click
 * the effect plays on (0 before the first click); the effect picked in the pane is marked.
 */
function animationTags(content: Any, slide: Any, view: Any, S: (p: Any) => Any): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let click = 0;
  const seen = new Map<string, number>();
  (slide.animations ?? []).forEach((a: Any, i: number) => {
    if (a.start === 'onClick' && !a.trigger) click += 1;
    const pl = placed(content, slide, a.shape);
    if (!pl) return;
    const k = seen.get(a.shape) ?? 0;
    seen.set(a.shape, k + 1);
    const p = S(apply(pl.m, {x: 0, y: 0}));
    const label = a.trigger ? '⚡' : String(a.start === 'onClick' ? click : click);
    const x = p.x - 22 - k * 20, y = p.y + 1;
    out.push(<g key={`tag${i}`} className={`prism-animtag${view?.animIndex === i ? ' is-picked' : ''}`} data-anim-tag={i} transform={`translate(${x} ${y})`}>
      <rect width={18} height={15} rx={3.5}/>
      {a.trigger ? <path d="M9.5 2.5 5.5 8.25H9L8.25 12.5 12.5 6.5H9Z" className="prism-animtag-bolt"/> : <text x={9} y={11.4} textAnchor="middle">{label}</text>}
    </g>);
  });
  return out;
}

const inkColor = (c: Any) => (c ? `rgba(${c.r},${c.g},${c.b},${(c.a ?? 255) / 255})` : '#000');
function arcPath(r: number) {
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) { const a = -0.4 + (i / 20) * 5.2; pts.push(`${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`); }
  return `M${pts.join(' L')}`;
}

/** The caret and the selected text of the shape being edited (deckcraft text_marks / caret_line). */
/** The table a shape is as drawn: its rows grown to their text, with the cell rectangles in table space. */
function tableGeom(content: Any, slide: Any, sh: Any) {
  const rc = ctxForSlide(content, slide);
  if (!rc) return null;
  const def = tableStyleOf(rc, sh.kind);
  const heights = tableDrawnHeights(rc, sh);
  return {rc, def, heights, rects: tableCellRects(sh.kind, heights)};
}

/** View Gridlines (dotted cell edges) and the selected range of cells (shaded, with an outline). */
function tableMarks(content: Any, slide: Any, sel: Any, gridlines: boolean, S: (p: Any) => Any): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const ids: string[] = gridlines ? (slide.shapes ?? []).filter((x: Any) => x.kind?.type === 'table' && !x.hidden).map((x: Any) => x.id) : [];
  if (sel.cells && !ids.includes(sel.cells.shape)) ids.push(sel.cells.shape);
  for (const id of ids) {
    const pl = placed(content, slide, id);
    if (!pl || pl.sh.kind?.type !== 'table') continue;
    const g = tableGeom(content, slide, pl.sh);
    if (!g) continue;
    const P = (x: number, y: number) => S(apply(pl.m, {x, y}));
    if (gridlines) {
      for (const r of g.rects) {
        const [a, b, c, d] = [P(r.x0, r.y0), P(r.x1, r.y0), P(r.x1, r.y1), P(r.x0, r.y1)];
        out.push(<polygon key={`gl${id}-${r.r}-${r.c}`} className="prism-tablegrid" points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`}/>);
      }
    }
    if (sel.cells && sel.cells.shape === id) {
      const [a, b] = cellBlock(pl.sh.kind, sel.cells.from, sel.cells.to);
      const [r0, r1, c0, c1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      const inside = g.rects.filter((r: Any) => r.r >= r0 && r.r <= r1 && r.c >= c0 && r.c <= c1);
      for (const r of inside) {
        const [p0, p1, p2, p3] = [P(r.x0, r.y0), P(r.x1, r.y0), P(r.x1, r.y1), P(r.x0, r.y1)];
        out.push(<polygon key={`cs${id}-${r.r}-${r.c}`} className="prism-cellsel" points={`${p0.x},${p0.y} ${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}/>);
      }
      if (inside.length) {
        const x0 = Math.min(...inside.map((r: Any) => r.x0)), y0 = Math.min(...inside.map((r: Any) => r.y0)), x1 = Math.max(...inside.map((r: Any) => r.x1)), y1 = Math.max(...inside.map((r: Any) => r.y1));
        const q = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
        out.push(<polygon key={`co${id}`} className="prism-cellrange" points={q.map(v => `${v.x},${v.y}`).join(' ')}/>);
      }
    }
  }
  return out;
}

/** The caret and the selected text of the cell being edited: the cell's text laid out in its rectangle, drawn through the table's placement. */
function cellTextMarks(content: Any, slide: Any, t: Any, S: (p: Any) => Any, scale: number): React.ReactNode[] {
  const pl = placed(content, slide, t.shape);
  if (!pl || pl.sh.kind?.type !== 'table') return [];
  const g = tableGeom(content, slide, pl.sh);
  const rect = g?.rects.find((r: Any) => r.r === t.cell[0] && r.c === t.cell[1]);
  const cell = pl.sh.kind.rows?.[t.cell[0]]?.cells?.[t.cell[1]];
  if (!g || !rect || !cell) return [];
  const body0 = tableCellBody(g.rc, pl.sh.kind, t.cell[0], t.cell[1], cell, g.def);
  const body = body0.paragraphs?.length ? body0 : {...body0, paragraphs: [{level: 0, runs: []}]};
  const r = {x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1};
  const l = layoutText(g.rc, tableCellShape(pl.sh, body), body, {rect: r, ...LAYOUT_OPTS});
  const c = {x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2};
  let tm = pl.m;
  if (l.rotation) tm = affChain(tm, affTranslate(c), affRotate((l.rotation * Math.PI) / 180), affTranslate({x: -c.x, y: -c.y}));
  const P = (px: number, py: number) => S(apply(tm, {x: px, y: py}));
  const [ap, ac] = posOf(cell.text ?? {paragraphs: []}, Math.min(t.anchor, 1e9));
  const [cp, cc] = posOf(cell.text ?? {paragraphs: []}, Math.min(t.caret, 1e9));
  const out: React.ReactNode[] = [];
  const before = (p1: number, c1: number, p2: number, c2: number) => p1 < p2 || (p1 === p2 && c1 < c2);
  if (ap !== cp || ac !== cc) {
    const [s0, s1] = before(ap, ac, cp, cc) ? [[ap, ac], [cp, cc]] : [[cp, cc], [ap, ac]];
    l.lines.forEach((ln: Any, i: number) => {
      if (ln.para < s0[0] || ln.para > s1[0]) return;
      const from = ln.para === s0[0] ? Math.max(s0[1], ln.offsetStart) : ln.offsetStart;
      const to = ln.para === s1[0] ? Math.min(s1[1], ln.offsetEnd) : ln.offsetEnd;
      if (to < from || (to === from && ln.para === s1[0])) return;
      const x0 = caretX(ln, from), x1 = caretX(ln, to) + (ln.para < s1[0] && to === ln.offsetEnd ? 4 : 0);
      const q = [P(Math.min(x0, x1), ln.top), P(Math.max(x0, x1), ln.top), P(Math.max(x0, x1), ln.bottom), P(Math.min(x0, x1), ln.bottom)];
      out.push(<polygon key={`ts${i}`} className="prism-textsel" points={q.map(v => `${v.x},${v.y}`).join(' ')}/>);
    });
  }
  const ln = lineAt(l, cp, cc);
  if (ln) {
    const cx = caretX(ln, cc);
    const a = P(cx, ln.top), b = P(cx, ln.bottom);
    out.push(<line key="caret" className="prism-caret" x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.max(1, Math.min(2, scale))}/>);
  }
  return out;
}

function textMarks(content: Any, slide: Any, t: Any, S: (p: Any) => Any, scale: number): React.ReactNode[] {
  if (t.cell) return cellTextMarks(content, slide, t, S, scale);
  const pl = placed(content, slide, t.shape);
  if (!pl) return [];
  const {m, x, sh} = pl;
  const ctx = ctxForSlide(content, slide);
  if (!ctx) return [];
  const geo = shapeGeometry(sh, x.w, x.h);
  const body = sh.text && (sh.text.paragraphs ?? []).length ? sh.text : {...(sh.text ?? {body: {}}), paragraphs: [{level: 0, runs: []}]};
  const l = layoutText(ctx, sh, body, {rect: geo.textRect, ...LAYOUT_OPTS});
  const tr = geo.textRect;
  const c = {x: (tr.x0 + tr.x1) / 2, y: (tr.y0 + tr.y1) / 2};
  let tm = m;
  if (affDeterminant(m) < 0) tm = affChain(tm, affTranslate(c), affScaleXY(-1, 1), affTranslate({x: -c.x, y: -c.y}));
  if (l.rotation) tm = affChain(tm, affTranslate(c), affRotate((l.rotation * Math.PI) / 180), affTranslate({x: -c.x, y: -c.y}));
  const P = (px: number, py: number) => S(apply(tm, {x: px, y: py}));
  const [ap, ac] = posOf(body, Math.min(t.anchor, 1e9));
  const [cp, cc] = posOf(body, Math.min(t.caret, 1e9));
  const out: React.ReactNode[] = [];
  const before = (p1: number, c1: number, p2: number, c2: number) => p1 < p2 || (p1 === p2 && c1 < c2);
  if (ap !== cp || ac !== cc) {
    const [s0, s1] = before(ap, ac, cp, cc) ? [[ap, ac], [cp, cc]] : [[cp, cc], [ap, ac]];
    l.lines.forEach((ln: Any, i: number) => {
      if (ln.para < s0[0] || ln.para > s1[0]) return;
      const from = ln.para === s0[0] ? Math.max(s0[1], ln.offsetStart) : ln.offsetStart;
      const to = ln.para === s1[0] ? Math.min(s1[1], ln.offsetEnd) : ln.offsetEnd;
      if (to < from || (to === from && ln.para === s1[0])) return;
      const x0 = caretX(ln, from), x1 = caretX(ln, to) + (ln.para < s1[0] && to === ln.offsetEnd ? 4 : 0);
      const q = [P(Math.min(x0, x1), ln.top), P(Math.max(x0, x1), ln.top), P(Math.max(x0, x1), ln.bottom), P(Math.min(x0, x1), ln.bottom)];
      out.push(<polygon key={`ts${i}`} className="prism-textsel" points={q.map(p => `${p.x},${p.y}`).join(' ')}/>);
    });
  }
  const ln = lineAt(l, cp, cc);
  if (ln) {
    const cx = caretX(ln, cc);
    const a = P(cx, ln.top), b = P(cx, ln.bottom);
    out.push(<line key="caret" className="prism-caret" x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.max(1, Math.min(2, scale))}/>);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Spelling squiggles (U:prism/spelling; deckcraft canvas/squiggles.rs): a red wavy line under each misspelt word of the slide's shapes and table cells,
// from the same issues as the Spelling pane (core/prism/lib/spelling-issues.mjs). Not under the word the caret is in.

/** A shape's text (or a table cell's) laid out, with the transform that places layout points on the slide. */
function textFrame(content: Any, slide: Any, id: string, cell: number[] | null): {l: Any; tm: Any} | null {
  const pl = placed(content, slide, id);
  if (!pl) return null;
  if (cell) {
    if (pl.sh.kind?.type !== 'table') return null;
    const g = tableGeom(content, slide, pl.sh);
    const rect = g?.rects.find((r: Any) => r.r === cell[0] && r.c === cell[1]);
    const c0 = pl.sh.kind.rows?.[cell[0]]?.cells?.[cell[1]];
    if (!g || !rect || !c0) return null;
    const body0 = tableCellBody(g.rc, pl.sh.kind, cell[0], cell[1], c0, g.def);
    const body = body0.paragraphs?.length ? body0 : {...body0, paragraphs: [{level: 0, runs: []}]};
    const r = {x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1};
    const l = layoutText(g.rc, tableCellShape(pl.sh, body), body, {rect: r, ...LAYOUT_OPTS});
    const c = {x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2};
    let tm = pl.m;
    if (l.rotation) tm = affChain(tm, affTranslate(c), affRotate((l.rotation * Math.PI) / 180), affTranslate({x: -c.x, y: -c.y}));
    return {l, tm};
  }
  const {m, x, sh} = pl;
  const ctx = ctxForSlide(content, slide);
  if (!ctx || !sh.text) return null;
  const geo = shapeGeometry(sh, x.w, x.h);
  const l = layoutText(ctx, sh, sh.text, {rect: geo.textRect, ...LAYOUT_OPTS});
  const tr = geo.textRect;
  const c = {x: (tr.x0 + tr.x1) / 2, y: (tr.y0 + tr.y1) / 2};
  let tm = m;
  if (affDeterminant(m) < 0) tm = affChain(tm, affTranslate(c), affScaleXY(-1, 1), affTranslate({x: -c.x, y: -c.y}));
  if (l.rotation) tm = affChain(tm, affTranslate(c), affRotate((l.rotation * Math.PI) / 180), affTranslate({x: -c.x, y: -c.y}));
  return {l, tm};
}

export interface SquiggleMark { issue: Any; x0: number; y0: number; x1: number; y1: number; top: number }

/** The underlines (slide coordinates) of the issues of one slide: one per line a word falls on. */
function squiggleMarks(content: Any, slide: Any, issues: Any[]): SquiggleMark[] {
  const out: SquiggleMark[] = [];
  const groups = new Map<string, Any[]>();
  for (const it of issues) {
    if (it.notes || it.shape === undefined) continue;
    const k = `${it.shape}|${it.row ?? ''}|${it.col ?? ''}`;
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(it);
  }
  for (const list of groups.values()) {
    const first = list[0];
    let frame: {l: Any; tm: Any} | null = null;
    try { frame = textFrame(content, slide, first.shape, first.row !== undefined ? [first.row, first.col] : null); } catch { frame = null; }
    if (!frame) continue;
    const {l, tm} = frame;
    for (const it of list) {
      for (const ln of l.lines) {
        if (ln.para !== it.para) continue;
        const from = Math.max(it.start, ln.offsetStart), to = Math.min(it.end, ln.offsetEnd);
        if (to <= from) continue;
        const xa = caretX(ln, from), xb = caretX(ln, to);
        const y = ln.baseline + (ln.bottom - ln.baseline) * 0.55;
        const a = apply(tm, {x: Math.min(xa, xb), y}), b = apply(tm, {x: Math.max(xa, xb), y});
        const top = apply(tm, {x: Math.min(xa, xb), y: ln.top});
        out.push({issue: it, x0: a.x, y0: a.y, x1: b.x, y1: b.y, top: top.y});
      }
    }
  }
  return out;
}

/** One squiggle as an SVG path in screen pixels (deckcraft squiggles::paint: a zig-zag of 2 px steps, 1 px line). */
function squigglePath(m: SquiggleMark, S: (p: {x: number; y: number}) => {x: number; y: number}, scale: number): string {
  const a = S({x: m.x0, y: m.y0}), b = S({x: m.x1, y: m.y1});
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 1) return '';
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const step = Math.min(Math.max(2 * scale, 1.5), 3), amp = step * 0.75;
  const pts: string[] = [];
  let up = false;
  for (let t = 0; t <= len; t += step) { pts.push(`${(a.x + ux * t + nx * (up ? -amp : amp)).toFixed(1)},${(a.y + uy * t + ny * (up ? -amp : amp)).toFixed(1)}`); up = !up; }
  return `M${pts.join(' L')}`;
}

/** The squiggled word at a slide point (within `tol` of its underline, from a line above it down to just below), or null (deckcraft Squiggles::word_at). */
export function squiggleAt(marks: SquiggleMark[], p: {x: number; y: number}, tol: number): Any | null {
  const hit = marks.find(m => p.x >= Math.min(m.x0, m.x1) - tol && p.x <= Math.max(m.x0, m.x1) + tol && p.y <= Math.max(m.y0, m.y1) + tol && p.y >= Math.min(m.top, m.y0, m.y1) - 2);
  return hit?.issue ?? null;
}
