// Crop mode on the page (Picture Format › Size › Crop): the selected picture's frame with Word's black crop handles, a corner
// bracket at each corner and a bar at each side. Dragging a handle trims that side: the picture keeps its scale, the frame
// shrinks (or grows back to what was cropped), and one picture.crop with the new fractions and size is run on release,
// so the drag is one undo step.
//
// Translated from wordcraft crates/ui-egui/src/crop.rs (the handles and the drag: `active`, `drag`, the fractions of the
// source and the 5% kept between two sides) at aadb077e072b7de05f724e359d8db82e151f125c, with picture.crop's `width` and
// `height` (a floating picture moves by what a left or top crop trims). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useRef, useState, type PointerEvent as RPointerEvent} from 'react';
import {dragCrop} from './crop-math.mjs';

export type CropHit = {rect: {x: number; y: number; w: number; h: number}; rot: number; crop: number[]};
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function CropHandles({hit, scale, onCommit}: {hit: CropHit; scale: number; onCommit: (p: {left: number; top: number; right: number; bottom: number; width: number; height: number}) => void}) {
  const [live, setLive] = useState<{crop: number[]; width: number; height: number; handle: Handle} | null>(null);
  const drag = useRef<{handle: Handle; x: number; y: number; last: ReturnType<typeof dragCrop> | null} | null>(null);
  const {rect, rot} = hit;
  const t = (rot * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const start = (handle: Handle) => (e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {handle, x: e.clientX, y: e.clientY, last: null};
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // The pointer's move in points, turned back into the picture's own directions.
    const gx = (e.clientX - d.x) / scale, gy = (e.clientY - d.y) / scale;
    const dx = gx * cos + gy * sin, dy = -gx * sin + gy * cos;
    d.last = dragCrop(d.handle, dx, dy, rect.w, rect.h, hit.crop);
    setLive({...d.last, handle: d.handle});
  };
  const end = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setLive(null);
    if (d?.last) onCommit({left: d.last.crop[0], top: d.last.crop[1], right: d.last.crop[2], bottom: d.last.crop[3], width: d.last.width, height: d.last.height});
  };
  return <div className="quill-crop-frame" data-crop-mode="true" style={{left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale, transform: rot ? `rotate(${rot}deg)` : undefined}}>
    {/* While dragging, the new frame: a left or top drag moves that edge with the pointer. */}
    {live ? <div className="quill-crop-preview" aria-hidden="true" style={{left: live.handle.includes('w') ? (rect.w - live.width) * scale : 0, top: live.handle.includes('n') ? (rect.h - live.height) * scale : 0, width: live.width * scale, height: live.height * scale}}/> : null}
    {HANDLES.map(h => <b key={h} className={`c-${h}`} role="slider" aria-label={`Crop ${h}`} data-crop-handle={h} onPointerDown={start(h)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}/>)}
  </div>;
}
