// Edit Points on the page (Shape Format › Edit Shape › Edit Points): the selected shape's outline with a black square at each
// vertex and, for the point picked, its two handles. Drag a vertex or a handle to reshape the outline (one shape.movePoint or
// shape.moveHandle on release, so one undo step), Ctrl-click a vertex to delete it or the outline to add a point there, click a
// segment or a point to pick it, right-click a point or a segment for its menu (the spec's edit-points-vertex and
// edit-points-segment menus read what was picked, view.editPointsPick).
//
// wordcraft has no Edit Points (not checked against upstream for Word). The geometry is PowerPoint's path engine
// (core/prism/lib/points.mjs: hit tests, `movedVertex`, `movedHandle`); the layer is Prism's pointer rules over a page.

import {useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent} from 'react';
import * as pts from '../../../../core/prism/lib/points.mjs';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Pt = {x: number; y: number};
export type PointsView = {vertex?: [number, number] | null; segment?: [number, number, number] | null; kind?: string} | null;
type Drag = {kind: 'vertex' | 'handle'; path: number; index: number; out: boolean; sx: number; sy: number; moved: boolean; to: Pt | null};

const TOL = 7; // pixels
const apply = (m: number[], q: Pt, sx: number, sy: number, scale: number): Pt => { const r = pts.toSlide(m, {x: q.x * sx, y: q.y * sy}); return {x: r.x * scale, y: r.y * scale}; };

/** The outline in page pixels, as path data. */
function outlineD(sh: Any, scale: number): string {
  const x = sh.xfrm, m = pts.affineOf(x);
  return sh.geom.paths.map((cp: Any) => {
    const sx = cp.w > 0 ? x.w / cp.w : 1, sy = cp.h > 0 ? x.h / cp.h : 1;
    const segs = pts.parse(cp.d);
    for (const s of segs) s.pts = s.pts.map((q: Pt) => apply(m, q, sx, sy, scale));
    return pts.write(segs);
  }).join(' ');
}

export function EditPoints({sh, state, scale, width, height, exec}: {sh: Any; state: PointsView; scale: number; width: number; height: number; exec: (command: string, params: Record<string, unknown>) => Promise<unknown> | void}) {
  const [live, setLive] = useState<Any | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const shown = live ?? sh;
  const x = shown.xfrm;
  const at = (e: {clientX: number; clientY: number}): Pt => {
    const r = svg.current?.getBoundingClientRect();
    return {x: (e.clientX - (r?.left ?? 0)) / scale, y: (e.clientY - (r?.top ?? 0)) / scale};
  };
  const pick = (params: Record<string, unknown>) => { void exec('view.editPointsPick', params); };

  const press = (kind: 'vertex' | 'handle', path: number, index: number, out = false) => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'vertex') {
      if (e.ctrlKey || e.metaKey) { void exec('shape.deletePoint', {path, index}); return; }
      pick({vertex: [path, index]});
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = {kind, path, index, out, sx: e.clientX, sy: e.clientY, moved: false, to: null};
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    d.moved = true;
    d.to = at(e);
    setLive(d.kind === 'vertex' ? pts.movedVertex(sh, d.path, d.index, d.to) : pts.movedHandle(sh, d.path, d.index, d.out, d.to, state?.kind ?? null));
  };
  const release = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setLive(null);
    if (!d?.moved || !d.to) return;
    if (d.kind === 'vertex') void exec('shape.movePoint', {path: d.path, index: d.index, x: d.to.x, y: d.to.y});
    else void exec('shape.moveHandle', {path: d.path, index: d.index, side: d.out ? 'out' : 'in', x: d.to.x, y: d.to.y, ...(state?.kind ? {type: state.kind} : {})});
  };

  // The outline itself: a click picks a segment, Ctrl-click adds a point on it, a click beside it goes to the page.
  const segmentAt = (e: {clientX: number; clientY: number}): Any => pts.segmentAt(sh, sh.xfrm, at(e), TOL / scale);
  const onOutline = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const seg = segmentAt(e);
    if (!seg) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) void exec('shape.addPoint', {path: seg.path, segment: seg.index, t: seg.t});
    else pick({segment: [seg.path, seg.index, seg.t]});
  };
  const onOutlineMenu = (e: RMouseEvent) => {
    const seg = segmentAt(e);
    if (seg) pick({segment: [seg.path, seg.index, seg.t]});
  };

  const d = outlineD(shown, scale);
  const chosen = state?.vertex ?? null;
  const handles = chosen ? pts.slideHandles(shown, x, chosen[0], chosen[1]) : null;
  const verts: Pt[][] = pts.slideVertices(shown, x);
  return <svg ref={svg} className="quill-edit-points" data-edit-points="" width={width * scale} height={height * scale} aria-hidden="true">
    <path className="quill-ep-outline" d={d} fill="none"/>
    <path className="quill-ep-hit" d={outlineD(sh, scale)} fill="none" data-context="edit-points-segment" onPointerDown={onOutline} onContextMenu={onOutlineMenu}/>
    {handles ? [[handles.hin, false], [handles.hout, true]].map(([q, out]: Any) => q ? <g key={String(out)}>
      <line className="quill-ep-arm" x1={handles.v.x * scale} y1={handles.v.y * scale} x2={q.x * scale} y2={q.y * scale}/>
      <circle className="quill-ep-handle" data-handle={out ? 'out' : 'in'} cx={q.x * scale} cy={q.y * scale} r={4.5} onPointerDown={press('handle', chosen![0], chosen![1], out)}
        onPointerMove={move} onPointerUp={release} onPointerCancel={release}/>
    </g> : null) : null}
    {verts.map((vs, pi) => vs.map((q, i) => {
      const on = !!chosen && chosen[0] === pi && chosen[1] === i;
      return <rect key={`${pi}:${i}`} className={`quill-ep-vertex${on ? ' is-chosen' : ''}`} data-vertex={`${pi}:${i}`} data-context="edit-points-vertex"
        x={q.x * scale - 4} y={q.y * scale - 4} width={8} height={8}
        onPointerDown={press('vertex', pi, i)} onPointerMove={move} onPointerUp={release} onPointerCancel={release}
        onContextMenu={() => pick({vertex: [pi, i]})}/>;
    }))}
  </svg>;
}
