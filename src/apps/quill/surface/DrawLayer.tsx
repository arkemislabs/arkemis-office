// The Draw tab's marks on a page (U:quill/draw): the stroke being drawn, the lasso loop being drawn
// and the dashed box round what the lasso selected. Drawn as SVG over the page, in page points scaled by
// the page's on-screen scale.

export type Live = {page: number; pts: [number, number][]; kind: 'stroke' | 'lasso' | 'erase'; color: [number, number, number]; width: number; alpha: number};
export type Box = {x: number; y: number; w: number; h: number};

export function DrawLayer({live, box, scale, width, height}: {live: Live | null; box: Box | null; scale: number; width: number; height: number}) {
  if (!live && !box) return null;
  const pts = live?.pts ?? [];
  const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * scale).toFixed(1)} ${(y * scale).toFixed(1)}`).join(' ');
  const rgb = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  return <svg className="quill-draw-layer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {live?.kind === 'stroke' ? (pts.length === 1
      ? <circle cx={pts[0][0] * scale} cy={pts[0][1] * scale} r={Math.max(live.width * scale / 2, 0.5)} fill={rgb(live.color)} opacity={live.alpha}/>
      : <path d={path} fill="none" stroke={rgb(live.color)} strokeWidth={Math.max(live.width * scale, 0.5)} strokeLinecap="round" strokeLinejoin="round" opacity={live.alpha}/>) : null}
    {live?.kind === 'lasso' && pts.length > 1 ? <path d={`${path} Z`} fill="rgba(80,140,255,0.10)" stroke="#5b9bff" strokeWidth={1.25} strokeDasharray="5 4"/> : null}
    {live?.kind === 'erase' && pts.length ? <circle cx={pts[pts.length - 1][0] * scale} cy={pts[pts.length - 1][1] * scale} r={7 * scale} fill="rgba(255,255,255,0.35)" stroke="#888" strokeWidth={1}/> : null}
    {box ? <rect x={box.x * scale - 3} y={box.y * scale - 3} width={box.w * scale + 6} height={box.h * scale + 6} fill="rgba(80,140,255,0.06)" stroke="#5b9bff" strokeWidth={1.25} strokeDasharray="5 4" data-lasso-box=""/> : null}
  </svg>;
}
