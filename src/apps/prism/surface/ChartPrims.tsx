// A chart drawn as SVG: the chart engine's primitives (core/prism/lib/chart.mjs `chartPrims`), one unit a point, in the
// box of the chart shape; used by the slide view and by the Insert Chart, Change Chart Type dialogs.

type Any = any;
const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;
const stroke = (s: [number[], number] | null) => (s ? {stroke: rgba(s[0]), strokeWidth: s[1]} : {});

export function Prims({prims}: {prims: Any[]}) {
  return <>{prims.map((p, i) => {
    switch (p.t) {
      case 'rect': return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.radius || undefined} fill={p.fill ? rgba(p.fill) : 'none'} {...stroke(p.stroke)}/>;
      case 'line': return <polyline key={i} points={p.pts.map((q: number[]) => q.join(',')).join(' ')} fill="none" stroke={rgba(p.color)} strokeWidth={p.width}
        strokeLinejoin="round" strokeLinecap="round" strokeDasharray={p.dash ? '4 3' : undefined}/>;
      case 'poly': return <polygon key={i} points={p.pts.map((q: number[]) => q.join(',')).join(' ')} fill={p.fill ? rgba(p.fill) : 'none'} {...stroke(p.stroke)}/>;
      case 'wedge': {
        const pt = (r: number, a: number) => `${p.cx + r * Math.sin(a)} ${p.cy - r * Math.cos(a)}`;
        const large = p.a1 - p.a0 > Math.PI ? 1 : 0;
        const d = p.ri > 0 ? `M${pt(p.ro, p.a0)}A${p.ro} ${p.ro} 0 ${large} 1 ${pt(p.ro, p.a1)}L${pt(p.ri, p.a1)}A${p.ri} ${p.ri} 0 ${large} 0 ${pt(p.ri, p.a0)}Z`
          : `M${p.cx} ${p.cy}L${pt(p.ro, p.a0)}A${p.ro} ${p.ro} 0 ${large} 1 ${pt(p.ro, p.a1)}Z`;
        return <path key={i} d={d} fill={rgba(p.fill)} {...stroke(p.stroke)}/>;
      }
      case 'circle': return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill ? rgba(p.fill) : 'none'} {...stroke(p.stroke)}/>;
      case 'text': {
        const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
        const base = p.valign === 'middle' ? 'central' : p.valign === 'bottom' ? 'text-after-edge' : 'text-before-edge';
        return <text key={i} x={p.x} y={p.y} fontSize={p.size} fill={rgba(p.color)} textAnchor={anchor} dominantBaseline={base} fontWeight={p.bold ? 700 : 400}
          fontFamily="Calibri, 'Segoe UI', sans-serif" transform={p.rotation ? `rotate(${(p.rotation * 180) / Math.PI} ${p.x} ${p.y})` : undefined}>{p.text}</text>;
      }
      default: return null;
    }
  })}</>;
}

/** A chart result (`{scale, prims}`) as a group in the shape's own units. */
export function ChartGroup({chart}: {chart: Any}) {
  return <g className="prism-chart" transform={`scale(${chart.scale})`}><Prims prims={chart.prims}/></g>;
}

/** A standalone preview (dialogs). */
export function ChartSvg({chart, label, className}: {chart: Any; label: string; className?: string}) {
  const w = chart.w * chart.scale, h = chart.h * chart.scale;
  return <svg className={className} viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={label}><ChartGroup chart={chart}/></svg>;
}
