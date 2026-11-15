// The page's ink layer (F:slate surface; docs/spec/slate.json panes › page-canvas "ink layer").
//
// Strokes are SVG paths over the notes, as OneNote draws ink above typed text. Pen strokes are
// opaque with round ends, pencil strokes are softer, highlighter strokes are wide, translucent and
// multiply with what is under them so text stays readable; galaxy and rainbow pens paint a gradient
// along the stroke. The active Draw tool (kept in the document view as `view.ink`) decides what a
// drag does:
//   pen / pencil / highlighter  a stroke follows the pointer live and is added on release (one undo
//                               step); along the Ruler's edge it runs straight;
//   shape                       a shape is outlined while dragging and drawn on release;
//   eraser                      the stroke eraser takes every stroke the drag touches, the small,
//                               medium and large erasers rub out the parts it passes over;
//   lasso                       a loop selects the strokes inside it, a click selects the stroke under
//                               it, a drag inside the selection moves it;
//   pan                         the page scrolls with the hand.
// Touch drawing can be switched off (Draw with Touch): a finger then scrolls instead.
//
// Everything that changes the page leaves through the callbacks (commands in PageCanvas).

import {useEffect, useRef, useState} from 'react';
import {strokePath, strokeHit, simplifyPoints} from '../../../../core/slate/model/canvas.mjs';
import {shapePolylines} from '../../../../core/slate/lib/shapes.mjs';

export interface Stroke { id: string; tool: 'pen' | 'pencil' | 'highlighter'; color: string; width: number; points: number[]; fx?: 'galaxy' | 'rainbow' | null; group?: string; shape?: string }
export interface InkTool { tool: string; color?: string; width?: number; eraser?: string; fx?: string | null; penId?: string; shape?: string; pen?: string }
export interface Point { x: number; y: number }
export interface RulerPose { x: number; y: number; angle: number }

export const ERASER_RADIUS: Record<string, number> = {small: 4, medium: 10, large: 20, stroke: 6};
const DRAWS = new Set(['pen', 'pencil', 'highlighter']);
export const RULER_LENGTH = 720;
export const RULER_HEIGHT = 58;

/** The stroke a tool draws: OneNote's defaults are a black 0.5 mm pen and a yellow 6 mm highlighter. */
export function inkStyle(tool: InkTool | null) {
  const kind = tool?.tool;
  const draws = !!kind && DRAWS.has(kind);
  const shape = kind === 'shape';
  const base = shape ? tool?.pen ?? 'pen' : kind;
  const color = /^#[0-9a-f]{6}$/i.test(tool?.color ?? '') ? tool!.color! : base === 'highlighter' ? '#ffff00' : base === 'pencil' ? '#5f5f5f' : '#000000';
  const width = Number.isFinite(tool?.width) && tool!.width! > 0 ? tool!.width! : base === 'highlighter' ? 22.7 : base === 'pencil' ? 3.8 : 1.9;
  const fx: 'galaxy' | 'rainbow' | null = tool?.fx === 'galaxy' || tool?.fx === 'rainbow' ? tool.fx : null;
  return {kind, base: (base ?? 'pen') as Stroke['tool'], color, width, fx, draws, shape, erases: kind === 'eraser', lasso: kind === 'lasso', pan: kind === 'pan'};
}

/** The points a finished drag leaves (a dot becomes a tiny dash so it has a length). */
export const finishPoints = (points: number[]) => (points.length === 2 ? [...points, points[0] + 0.1, points[1]] : simplifyPoints(points));

/** A shape's strokes are drawn corner to corner (the smoothing a pen stroke gets would round its corners). */
const polyPath = (p: number[]) => { let d = `M${p[0]} ${p[1]}`; for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`; return d; };

const FX_STOPS: Record<string, string[]> = {
  galaxy: ['#2a1d7a', '#6a3fd0', '#c25ad8', '#4aa3ff', '#2a1d7a'],
  rainbow: ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#af52de'],
};

function bounds(points: number[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) { x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]); y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1]); }
  return {x0, y0, x1, y1};
}

function Gradients({strokes}: {strokes: Stroke[]}) {
  const fx = strokes.filter(s => s.fx);
  if (!fx.length) return null;
  return <defs>{fx.map(s => {
    const b = bounds(s.points);
    const stops = FX_STOPS[s.fx!] ?? FX_STOPS.rainbow;
    const flatH = b.y1 - b.y0 < 1, flatW = b.x1 - b.x0 < 1;
    return <linearGradient key={s.id} id={`fx-${s.id}`} gradientUnits="userSpaceOnUse" x1={b.x0} y1={flatH ? b.y0 : b.y0} x2={flatW ? b.x0 : b.x1} y2={flatH ? b.y0 : b.y1}>
      {stops.map((c, i) => <stop key={i} offset={`${(i / (stops.length - 1)) * 100}%`} stopColor={c}/>)}
    </linearGradient>;
  })}</defs>;
}

/** Part of a stroke: the points up to a fraction of its length (Ink Replay). */
function partial(points: number[], fraction: number): number[] {
  if (fraction >= 1) return points;
  let total = 0;
  for (let i = 2; i < points.length; i += 2) total += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  let want = total * fraction, out = [points[0], points[1]];
  for (let i = 2; i < points.length && want > 0; i += 2) {
    const d = Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    if (d <= want) { out.push(points[i], points[i + 1]); want -= d; } else { const t = want / d; out.push(points[i - 2] + (points[i] - points[i - 2]) * t, points[i - 1] + (points[i + 1] - points[i - 1]) * t); want = 0; }
  }
  if (out.length === 2) out = [...out, out[0] + 0.1, out[1]];
  return out;
}

/** The straight line a stroke drawn along the ruler's edge follows, or null when it starts away from both edges. */
export function rulerLine(pose: RulerPose, at: Point) {
  const a = (pose.angle * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
  const nx = -uy, ny = ux;
  const rel = {x: at.x - pose.x, y: at.y - pose.y};
  const along = rel.x * ux + rel.y * uy, across = rel.x * nx + rel.y * ny;
  if (along < -14 || along > RULER_LENGTH + 14) return null;
  for (const edge of [0, RULER_HEIGHT]) {
    if (Math.abs(across - edge) <= 14) return {ox: pose.x + edge * nx, oy: pose.y + edge * ny, ux, uy, len: RULER_LENGTH};
  }
  return null;
}
const onLine = (line: NonNullable<ReturnType<typeof rulerLine>>, x: number, y: number): [number, number] => {
  const t = Math.max(0, Math.min(line.len, (x - line.ox) * line.ux + (y - line.oy) * line.uy));
  return [Math.round((line.ox + t * line.ux) * 10) / 10, Math.round((line.oy + t * line.uy) * 10) / 10];
};

export interface InkLayerProps {
  strokes: Stroke[]; tool: InkTool | null; zoom: number; selected: Set<string>; touchDraw: boolean; ruler: RulerPose | null;
  replay: {run: number; ids: string[]} | null; inkToShape: boolean;
  onStroke: (s: Omit<Stroke, 'id'>) => void;
  onErase: (path: number[], radius: number, mode: 'stroke' | 'point') => void;
  onLasso: (path: number[]) => void;
  onPick: (x: number, y: number) => void;
  onMove: (dx: number, dy: number) => void;
  onShape: (shape: string, from: Point, to: Point) => void;
  onRuler: (pose: RulerPose) => void;
}

export function InkLayer(props: InkLayerProps) {
  const {strokes, tool, zoom, selected, touchDraw, ruler, replay, onStroke, onErase, onLasso, onPick, onMove, onShape, onRuler} = props;
  const st = inkStyle(tool);
  const active = st.draws || st.shape || st.erases || st.lasso || st.pan;
  const [live, setLive] = useState<number[] | null>(null);
  const [loop, setLoop] = useState<number[] | null>(null);
  const [shapeDrag, setShapeDrag] = useState<{from: Point; to: Point} | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const [eraserAt, setEraserAt] = useState<Point | null>(null);
  const [drag, setDrag] = useState<{dx: number; dy: number} | null>(null);
  const gesture = useRef<{kind: string; pointer: number; points: number[]; from: Point; line?: ReturnType<typeof rulerLine>; scroll?: {el: HTMLElement; x: number; y: number}} | null>(null);
  const radius = ERASER_RADIUS[tool?.eraser ?? 'stroke'] ?? 6;
  const pointErase = st.erases && (tool?.eraser ?? 'stroke') !== 'stroke';

  // Ink Replay: the strokes in the order they were drawn, each growing along its length.
  const [playing, setPlaying] = useState<{ids: string[]; index: number; fraction: number} | null>(null);
  useEffect(() => {
    if (!replay || !replay.ids.length) return;
    let raf = 0, index = 0, start = performance.now();
    const length = (s: Stroke) => { let l = 0; for (let i = 2; i < s.points.length; i += 2) l += Math.hypot(s.points[i] - s.points[i - 2], s.points[i + 1] - s.points[i - 1]); return l; };
    const byId = new Map(strokes.map(s => [s.id, s]));
    const list = replay.ids.map(id => byId.get(id)).filter((s): s is Stroke => !!s);
    if (!list.length) return;
    const duration = (s: Stroke) => Math.max(220, Math.min(2400, (length(s) / 700) * 1000));
    const tick = (now: number) => {
      let d = duration(list[index]);
      while (now - start >= d) {
        start += d; index++;
        if (index >= list.length) { setPlaying(null); return; }
        d = duration(list[index]);
      }
      setPlaying({ids: list.map(s => s.id), index, fraction: (now - start) / d});
      raf = requestAnimationFrame(tick);
    };
    setPlaying({ids: list.map(s => s.id), index: 0, fraction: 0});
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); setPlaying(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.run]);

  const at = (e: {clientX: number; clientY: number}, el: Element): Point => {
    const r = el.getBoundingClientRect();
    return {x: Math.round(((e.clientX - r.left) / zoom) * 10) / 10, y: Math.round(((e.clientY - r.top) / zoom) * 10) / 10};
  };
  const hitAt = (x: number, y: number, into: Set<string>) => {
    for (const s of strokes) if (!into.has(s.id) && strokeHit(s, x, y, radius)) into.add(s.id);
    // A shape is one object: its strokes go together.
    const groups = new Set(strokes.filter(s => into.has(s.id) && s.group).map(s => s.group));
    if (groups.size) for (const s of strokes) if (s.group && groups.has(s.group)) into.add(s.id);
  };
  const selectedBox = () => {
    const list = strokes.filter(s => selected.has(s.id));
    if (!list.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of list) { const b = bounds(s.points); x0 = Math.min(x0, b.x0 - s.width / 2); y0 = Math.min(y0, b.y0 - s.width / 2); x1 = Math.max(x1, b.x1 + s.width / 2); y1 = Math.max(y1, b.y1 + s.width / 2); }
    return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
  };
  const box = selectedBox();

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!active || e.button !== 0) return;
    if (e.pointerType === 'touch' && !touchDraw) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const p = at(e, e.currentTarget);
    if (st.draws) {
      const line = ruler ? rulerLine(ruler, p) : null;
      const start: [number, number] = line ? onLine(line, p.x, p.y) : [p.x, p.y];
      gesture.current = {kind: 'draw', pointer: e.pointerId, points: [...start], from: p, line};
      setLive([...start]);
    } else if (st.shape) { gesture.current = {kind: 'shape', pointer: e.pointerId, points: [], from: p}; setShapeDrag({from: p, to: p}); }
    else if (st.erases) {
      const s = new Set<string>();
      if (!pointErase) hitAt(p.x, p.y, s);
      gesture.current = {kind: 'erase', pointer: e.pointerId, points: [p.x, p.y], from: p};
      setErasing(s); setEraserAt(p);
    } else if (st.lasso) {
      const inside = box && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
      gesture.current = {kind: inside ? 'move' : 'lasso', pointer: e.pointerId, points: [p.x, p.y], from: p};
      if (inside) setDrag({dx: 0, dy: 0}); else setLoop([p.x, p.y]);
    } else if (st.pan) {
      const el = e.currentTarget.closest('.slate-page-scroll') as HTMLElement | null;
      gesture.current = {kind: 'pan', pointer: e.pointerId, points: [], from: {x: e.clientX, y: e.clientY}, scroll: el ? {el, x: el.scrollLeft, y: el.scrollTop} : undefined};
    }
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const list = events.length ? events : [e.nativeEvent];
    const r = e.currentTarget.getBoundingClientRect();
    const pt = (ev: {clientX: number; clientY: number}) => ({x: Math.round(((ev.clientX - r.left) / zoom) * 10) / 10, y: Math.round(((ev.clientY - r.top) / zoom) * 10) / 10});
    if (g.kind === 'draw') {
      for (const ev of list) { const p = pt(ev); g.points.push(...(g.line ? onLine(g.line, p.x, p.y) : [p.x, p.y])); }
      setLive(g.points.slice());
    } else if (g.kind === 'shape') setShapeDrag({from: g.from, to: pt(e.nativeEvent)});
    else if (g.kind === 'erase') {
      const next = new Set(erasing);
      for (const ev of list) { const p = pt(ev); g.points.push(p.x, p.y); if (!pointErase) hitAt(p.x, p.y, next); }
      setEraserAt(pt(e.nativeEvent));
      if (next.size !== erasing.size) setErasing(next);
    } else if (g.kind === 'lasso') { for (const ev of list) { const p = pt(ev); g.points.push(p.x, p.y); } setLoop(g.points.slice()); }
    else if (g.kind === 'move') { const p = pt(e.nativeEvent); setDrag({dx: p.x - g.from.x, dy: p.y - g.from.y}); }
    else if (g.kind === 'pan' && g.scroll) { g.scroll.el.scrollLeft = g.scroll.x - (e.clientX - g.from.x); g.scroll.el.scrollTop = g.scroll.y - (e.clientY - g.from.y); }
  };
  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    const p = at(e, e.currentTarget);
    if (g.kind === 'draw') {
      setLive(null);
      onStroke({tool: st.base, color: st.color, width: st.width, points: finishPoints(g.points), ...(st.fx ? {fx: st.fx} : {})});
    } else if (g.kind === 'shape') {
      setShapeDrag(null);
      if (Math.hypot(p.x - g.from.x, p.y - g.from.y) >= 6) onShape(tool!.shape!, g.from, p);
    } else if (g.kind === 'erase') {
      const hit = [...erasing];
      setErasing(new Set()); setEraserAt(null);
      if (pointErase || hit.length) onErase(g.points, radius, pointErase ? 'point' : 'stroke');
    } else if (g.kind === 'lasso') {
      setLoop(null);
      if (g.points.length <= 8 || Math.hypot(p.x - g.from.x, p.y - g.from.y) < 6 && g.points.length < 20) onPick(g.from.x, g.from.y);
      else onLasso(g.points);
    } else if (g.kind === 'move') {
      const d = drag; setDrag(null);
      if (d && Math.hypot(d.dx, d.dy) >= 2) onMove(Math.round(d.dx), Math.round(d.dy));
      else onPick(g.from.x, g.from.y);
    }
  };
  const cancel = () => { gesture.current = null; setLive(null); setLoop(null); setShapeDrag(null); setErasing(new Set()); setEraserAt(null); setDrag(null); };

  const shapeDraw = shapeDrag && tool?.shape ? (() => { try { return shapePolylines(tool.shape, shapeDrag.from, shapeDrag.to); } catch { return []; } })() : [];
  const hidden = playing ? new Set(playing.ids.slice(playing.index + 1)) : null;
  const dragging = drag && selected.size ? `translate(${drag.dx} ${drag.dy})` : undefined;
  const paint = (s: Stroke, points: number[]) => <path key={s.id} d={s.shape ? polyPath(points) : strokePath(points)} className={`slate-stroke is-${s.tool}${s.fx ? ' has-fx' : ''}${erasing.has(s.id) ? ' is-erased' : ''}`}
    stroke={s.fx ? `url(#fx-${s.id})` : s.color} strokeWidth={s.width} data-id={s.id} data-group={s.group}/>;

  return <svg className={`slate-ink${active ? ' is-active' : ''}${st.erases ? ' is-erasing' : ''}${st.lasso ? ' is-lasso' : ''}${st.pan ? ' is-pan' : ''}${st.shape ? ' is-shape' : ''}${touchDraw ? '' : ' no-touch'}`}
    aria-hidden={!strokes.length} role="img" aria-label={strokes.length ? `${strokes.length} ink strokes` : undefined}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
    <Gradients strokes={strokes}/>
    {strokes.map(s => {
      if (hidden?.has(s.id)) return null;
      if (playing && playing.ids[playing.index] === s.id) return paint(s, partial(s.points, playing.fraction));
      const moving = selected.has(s.id) && dragging;
      return moving ? <g key={s.id} transform={dragging}>{paint(s, s.points)}</g> : paint(s, s.points);
    })}
    {live ? <path d={strokePath(live)} className={`slate-stroke is-${st.base}${st.fx ? ' has-fx' : ''} is-live`} stroke={st.color} strokeWidth={st.width}/> : null}
    {shapeDraw.map((pts, i) => <path key={i} d={polyPath(pts)} className={`slate-stroke is-${st.base} is-live`} stroke={st.color} strokeWidth={st.width}/>)}
    {box ? <rect className="slate-ink-selection" x={box.x - 4 + (drag?.dx ?? 0)} y={box.y - 4 + (drag?.dy ?? 0)} width={box.w + 8} height={box.h + 8} rx={3}/> : null}
    {loop && loop.length >= 4 ? <path className="slate-lasso" d={`M${loop[0]} ${loop[1]}${Array.from({length: loop.length / 2 - 1}, (_, i) => `L${loop[2 * i + 2]} ${loop[2 * i + 3]}`).join('')}`}/> : null}
    {pointErase && eraserAt ? <circle className="slate-eraser-ring" cx={eraserAt.x} cy={eraserAt.y} r={radius}/> : null}
    {ruler ? <RulerWidget pose={ruler} zoom={zoom} onChange={onRuler}/> : null}
  </svg>;
}

/** The ruler (Draw › Ruler): a bar with centimetre ticks. Drag to place it, the wheel turns it. */
function RulerWidget({pose, zoom, onChange}: {pose: RulerPose; zoom: number; onChange: (p: RulerPose) => void}) {
  const drag = useRef<{px: number; py: number; x: number; y: number} | null>(null);
  const ticks: React.ReactNode[] = [];
  const cm = 96 / 2.54;
  for (let i = 0; i * (cm / 10) <= RULER_LENGTH; i++) {
    const x = i * (cm / 10), major = i % 10 === 0, half = i % 5 === 0;
    ticks.push(<line key={i} x1={x} x2={x} y1={0} y2={major ? 16 : half ? 11 : 7} className="slate-ruler-tick"/>);
    if (major && i > 0) ticks.push(<text key={`t${i}`} x={x} y={30} className="slate-ruler-label" textAnchor="middle">{i / 10}</text>);
  }
  return <g className="slate-ruler" transform={`translate(${pose.x} ${pose.y}) rotate(${pose.angle})`} aria-label="Ruler"
    onPointerDown={e => { e.stopPropagation(); e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic */ } drag.current = {px: e.clientX, py: e.clientY, x: pose.x, y: pose.y}; }}
    onPointerMove={e => { const d = drag.current; if (d) onChange({...pose, x: Math.max(0, d.x + (e.clientX - d.px) / zoom), y: Math.max(0, d.y + (e.clientY - d.py) / zoom)}); }}
    onPointerUp={() => { drag.current = null; }}
    onWheel={e => { e.stopPropagation(); onChange({...pose, angle: Math.round(((pose.angle + (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 15 : 1)) % 360) * 10) / 10}); }}>
    <rect className="slate-ruler-body" x={0} y={0} width={RULER_LENGTH} height={RULER_HEIGHT} rx={4}/>
    {ticks}
    <text x={RULER_LENGTH - 8} y={RULER_HEIGHT - 10} className="slate-ruler-label" textAnchor="end">{Math.round(pose.angle)}°</text>
  </g>;
}
