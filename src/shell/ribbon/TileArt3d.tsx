// A picture for gallery tiles (Prism's Shape Effects > Preset and 3-D Rotation): a sample shape with the effect or the rotation applied, drawn from
// the same projection the slide is drawn with (core/prism/lib/camera3d.mjs).

import {projection, aboutCenter, CAMERA_ROTATION} from '../../../core/prism/lib/camera3d.mjs';
import {flat3d, apply3d} from '../../../core/prism/lib/three-d.mjs';

export interface Shape3dArt { kind: 'shape3d'; camera?: string | null; depth?: number; bevel?: boolean; shadow?: string | null; glow?: boolean; reflection?: boolean; none?: boolean }

/** A rounded sample shape drawn through a camera preset, with a depth, a bevel, a shadow, a glow or a reflection. */
export function Shape3dTile({art, uid}: {art: Shape3dArt; uid: string}) {
  const w = 56, h = 44, sw = 26, sh = 17, cx = w / 2, cy = h / 2 - (art.reflection ? 4 : 0);
  const s3 = flat3d() as any;
  if (art.camera && art.camera in (CAMERA_ROTATION as Record<string, unknown>)) apply3d(s3, {camera: art.camera, depth: art.depth ?? 0});
  else if (art.depth) apply3d(s3, {depth: art.depth});
  const p = projection(s3) as {a: number; b: number; c: number; d: number; ex: number; ey: number} | null;
  const m = p ? aboutCenter(p, 0, 0) : [1, 0, 0, 1, 0, 0];
  const body = `translate(${cx} ${cy}) matrix(${m.slice(0, 4).join(' ')} 0 0)`;
  const x0 = -sw / 2, y0 = -sh / 2;
  const depth = (art.depth ?? 0) * 0.45;
  const copies = p && depth > 0.5 ? Array.from({length: Math.ceil(depth * 2)}, (_, k) => (Math.ceil(depth * 2) - k) / (Math.ceil(depth * 2) * 1)) : [];
  const fill = '#4472C4';
  return <svg className="tile-art tile-art-shape3d" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
    <defs>
      <filter id={`${uid}b`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation={1.6}/></filter>
      <linearGradient id={`${uid}r`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient>
      <mask id={`${uid}m`} maskUnits="userSpaceOnUse" x={-w} y={sh / 2} width={w * 2} height={sh}><rect x={-w} y={sh / 2 + 1} width={w * 2} height={sh * 0.6} fill={`url(#${uid}r)`}/></mask>
    </defs>
    <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.4)"/>
    {art.none ? <g transform={`translate(${cx} ${cy})`}><rect x={x0} y={y0} width={sw} height={sh} rx={2} fill="none" stroke="#888" strokeDasharray="2 2"/><path d={`M${x0 + 3} ${y0 + 3}L${x0 + sw - 3} ${y0 + sh - 3}`} stroke="#c33" strokeWidth={1.2}/></g> : <g transform={body}>
      {art.shadow ? <rect x={x0 + 2.5} y={y0 + 3} width={sw} height={sh} rx={2} fill="#000" opacity={0.35} filter={`url(#${uid}b)`}/> : null}
      {art.glow ? <rect x={x0} y={y0} width={sw} height={sh} rx={2} fill="#ffc000" opacity={0.7} filter={`url(#${uid}b)`} transform="scale(1.18)"/> : null}
      {copies.map((f, k) => <rect key={k} x={x0 + (p?.ex ?? 0) * depth * f} y={y0 + (p?.ey ?? 0) * depth * f} width={sw} height={sh} rx={2} fill="#2b4a86"/>)}
      <rect x={x0} y={y0} width={sw} height={sh} rx={2} fill={fill}/>
      {art.bevel ? <><path d={`M${x0 + 1} ${y0 + sh - 1}V${y0 + 1}H${x0 + sw - 1}`} fill="none" stroke="#fff" strokeOpacity={0.75} strokeWidth={1.6}/><path d={`M${x0 + sw - 1} ${y0 + 1}V${y0 + sh - 1}H${x0 + 1}`} fill="none" stroke="#000" strokeOpacity={0.35} strokeWidth={1.6}/></> : null}
      {art.reflection ? <g mask={`url(#${uid}m)`}><g transform={`translate(0 ${sh + 2}) scale(1 -1)`}><rect x={x0} y={y0} width={sw} height={sh} rx={2} fill={fill}/></g></g> : null}
    </g>}
  </svg>;
}
