// Edit Wrap Points on the page (Layout, Picture and Shape Format › Wrap Text › Edit Wrap Points): the outline text follows round the selected
// Tight or Through object, as a red polygon with a black square at each point. Drag a point to move it (one wrap.movePoint on release, one undo step),
// Ctrl-click a point to delete it (wrap.deletePoint), click the small circle in the middle of a side to add a point there (wrap.addPoint).
//
// Not checked against upstream (wordcraft keeps and lays out a wrap polygon but has no editor; this follows Word). Points are fractions of the object.

import {useRef, useState, type PointerEvent as RPointerEvent} from 'react';

type Rect = {x: number; y: number; w: number; h: number};
type Drag = {index: number; moved: boolean; sx: number; sy: number};

export function WrapPoints({unit, rect, rot, scale, width, height, exec}: {unit: [number, number][]; rect: Rect; rot: number; scale: number; width: number; height: number;
  exec: (command: string, params: Record<string, unknown>) => Promise<unknown> | void}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [live, setLive] = useState<[number, number][] | null>(null);
  const pts = live ?? unit;
  const cx = (rect.x + rect.w / 2) * scale, cy = (rect.y + rect.h / 2) * scale;
  const toPx = ([u, v]: [number, number]): [number, number] => [(rect.x + u * rect.w) * scale, (rect.y + v * rect.h) * scale];
  /** A pointer's place as fractions of the object (the object's turn undone). */
  const toUnit = (e: {clientX: number; clientY: number}): [number, number] => {
    const b = svg.current?.getBoundingClientRect();
    const px = e.clientX - (b?.left ?? 0) - cx, py = e.clientY - (b?.top ?? 0) - cy;
    const a = (-rot * Math.PI) / 180, qx = px * Math.cos(a) - py * Math.sin(a), qy = px * Math.sin(a) + py * Math.cos(a);
    return [(qx + cx) / scale / Math.max(rect.w, 1e-6) - rect.x / Math.max(rect.w, 1e-6), (qy + cy) / scale / Math.max(rect.h, 1e-6) - rect.y / Math.max(rect.h, 1e-6)];
  };
  const press = (index: number) => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) { void exec('wrap.deletePoint', {index}); return; }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = {index, moved: false, sx: e.clientX, sy: e.clientY};
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    d.moved = true;
    const q = toUnit(e);
    setLive(unit.map((p, i) => (i === d.index ? q : p)));
  };
  const release = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (!d?.moved) { setLive(null); return; }
    const q = toUnit(e);
    setLive(null);
    void exec('wrap.movePoint', {index: d.index, x: q[0], y: q[1]});
  };
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${toPx(p)[0].toFixed(1)} ${toPx(p)[1].toFixed(1)}`).join(' ') + 'Z';
  return <svg ref={svg} className="quill-wrap-points" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 6}} aria-label="Wrap points">
    <g transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}>
      <path d={path} fill="none" stroke="#d93025" strokeWidth={1.25}/>
      {pts.map((p, i) => {
        const a = toPx(p), b = toPx(pts[(i + 1) % pts.length]);
        return <circle key={`m${i}`} cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} r={3.5} fill="#fff" stroke="#d93025" strokeWidth={1} style={{pointerEvents: 'all', cursor: 'copy'}}
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); void exec('wrap.addPoint', {index: i}); }}/>;
      })}
      {pts.map((p, i) => <rect key={i} x={toPx(p)[0] - 3.5} y={toPx(p)[1] - 3.5} width={7} height={7} fill="#111" stroke="#fff" strokeWidth={1} data-wrap-point={i}
        style={{pointerEvents: 'all', cursor: 'move'}} onPointerDown={press(i)} onPointerMove={move} onPointerUp={release} onPointerCancel={release}/>)}
    </g>
  </svg>;
}
