// The pictures a gallery tile or a menu row can draw instead of an icon, from the `art` a command's
// state gives an item: a theme (Aa on its light colour with six accent bars), a row of colour
// swatches, a font pair, an effect sample and a background style. Pure SVG, drawn from the data.

import {useEffect, useId, useRef, type ReactElement} from 'react';
import {DiagramArt} from './DiagramArt';
import {Shape3dTile, type Shape3dArt} from './TileArt3d';
import {TableStyleArt, type TableStyleArtData} from './TableStyleArt';
import {iconRow} from '../../../core/grid/lib/cf-icons.mjs';
import {textureBitmap} from '../../../core/quill/lib/textures.mjs';

export type TileArtData =
  | {kind: 'theme'; bg: string; fg: string; accents: string[]; font?: string}
  | {kind: 'colors'; colors: string[]}
  | {kind: 'fonts'; major: string; minor: string}
  | {kind: 'effect'; line: number; shadow: {blur: number; dist: number; alpha: number} | null; glow: number | null; flat?: boolean}
  | {kind: 'bgstyle'; color?: string; stops?: [number, string][]; angle?: number}
  | {kind: 'pivot'; header: string | null; line: string | null; band: string | null; text: string}
  | {kind: 'slicer'; frame: string; body: string; header: string; headerText: string; on: string; onLine: string; onText: string; off: string; offLine: string; offText: string}
  | TableStyleArtData
  | {kind: 'table'; header: string | null; band: string | null; body: string | null; line: string | null; text: string}
  | {kind: 'diagram'; items: any[]}
  | {kind: 'chart'; colors: string[]; grid?: boolean; labels?: boolean; legend?: 'none' | 'bottom' | 'top' | 'left' | 'right'; axes?: boolean; type?: string}
  | {kind: 'pictureStyle'; style: string}
  | {kind: 'gradient'; fill: any}
  | {kind: 'shapeStyle'; fill: number[] | null; line: number[] | null; lineWidth: number; shadow: boolean}
  | {kind: 'wordArt'; effects: any}
  | {kind: 'artistic'; effect: string}
  | {kind: 'texture'; id: string}
  | {kind: 'textStyle'; label: string; sample?: string; font?: string; size?: number; bold?: boolean; italic?: boolean; color?: string | null; caps?: boolean; smallCaps?: boolean; underline?: boolean; strike?: boolean; spacing?: number}
  | {kind: 'cf'; mode: 'dataBar'; color: string; gradient: boolean}
  | {kind: 'cf'; mode: 'colorScale'; colors: string[]}
  | {kind: 'cf'; mode: 'iconSet'; set: string}
  | {kind: 'line'; style: string; color?: string}
  | {kind: 'objPhoto'; filter?: string; opacity?: number; border?: string | null; borderWidth?: number; shape?: string; shadow?: boolean}
  | {kind: 'sparkline'; series: string; negative: string; markers: string; first: string; last: string; high: string; low: string}
  | Shape3dArt;

const face = (f?: string) => (f ? `"${f}", var(--ark-font, 'Segoe UI'), sans-serif` : undefined);

/** A texture tile (Shape Fill › Texture): the tile's own pixels, drawn twice across so the repeat shows. */
function TextureArt({id}: {id: string}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current, bmp = textureBitmap(id, 32), g = cv?.getContext('2d');
    if (!cv || !bmp || !g) return;
    const tile = document.createElement('canvas');
    tile.width = bmp.width; tile.height = bmp.height;
    tile.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(bmp.data), bmp.width, bmp.height), 0, 0);
    g.drawImage(tile, 0, 0); g.drawImage(tile, 32, 0); g.drawImage(tile, 0, 32); g.drawImage(tile, 32, 32);
  }, [id]);
  return <canvas ref={ref} className="tile-art tile-art-texture" width={64} height={64} aria-hidden="true" style={{width: 36, height: 36, display: 'block', borderRadius: 3, boxShadow: '0 0 0 1px rgba(128,128,128,.5)'}}/>;
}

export function TileArt({art}: {art: TileArtData}) {
  const uid = useId().replace(/:/g, '');
  switch (art.kind) {
    case 'objPhoto': {
      // Picture Format: a sample picture (sky, sun, hills) with the corrections, effect, transparency, border, frame shape and shadow a gallery tile stands for.
      const w = 56, h = 42, id = `ph${uid}`, bw = art.borderWidth ?? 0;
      const x0 = 5 + bw / 2, y0 = 4 + bw / 2, iw = w - 14 - bw, ih = h - 12 - bw;
      const clip = art.shape === 'ellipse' ? <ellipse cx={x0 + iw / 2} cy={y0 + ih / 2} rx={iw / 2} ry={ih / 2}/> : <rect x={x0} y={y0} width={iw} height={ih} rx={art.shape === 'roundRect' ? 6 : 0}/>;
      return <svg className="tile-art tile-art-photo" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={`${id}c`}>{clip}</clipPath>
          {art.shadow ? <filter id={`${id}s`} x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx={2} dy={2} stdDeviation={1.8} floodColor="#000" floodOpacity={0.45}/></filter> : null}
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5b9bd5"/><stop offset="0.65" stopColor="#bcd7ee"/></linearGradient>
        </defs>
        <g filter={art.shadow ? `url(#${id}s)` : undefined}>
          <g clipPath={`url(#${id}c)`} style={{filter: art.filter || undefined, opacity: art.opacity ?? 1}}>
            <rect x={x0} y={y0} width={iw} height={ih} fill={`url(#${id}g)`}/>
            <circle cx={x0 + iw * 0.72} cy={y0 + ih * 0.3} r={ih * 0.14} fill="#f5c542"/>
            <path d={`M${x0} ${y0 + ih} L${x0} ${y0 + ih * 0.72} L${x0 + iw * 0.3} ${y0 + ih * 0.46} L${x0 + iw * 0.55} ${y0 + ih * 0.7} L${x0 + iw * 0.78} ${y0 + ih * 0.55} L${x0 + iw} ${y0 + ih * 0.78} L${x0 + iw} ${y0 + ih} Z`} fill="#548235"/>
          </g>
          {art.border ? (art.shape === 'ellipse' ? <ellipse cx={x0 + iw / 2} cy={y0 + ih / 2} rx={iw / 2} ry={ih / 2} fill="none" stroke={art.border} strokeWidth={bw}/>
            : <rect x={x0} y={y0} width={iw} height={ih} rx={art.shape === 'roundRect' ? 6 : 0} fill="none" stroke={art.border} strokeWidth={bw}/>) : null}
        </g>
        {art.border === '#FFFFFF' ? <rect x={x0 - 0.5} y={y0 - 0.5} width={iw + 1} height={ih + 1} fill="none" stroke="rgba(128,128,128,.45)" strokeWidth={0.6}/> : null}
      </svg>;
    }
    case 'sparkline': {
      // Sparkline Styles: a column sparkline with a negative column, and a line with the marked points, in the style's colours.
      const cols = [8, 5, 11, -6, 4, 9];
      const bars = cols.map((v, i) => <rect key={i} x={4 + i * 6} y={v >= 0 ? 16 - v : 16} width={4} height={Math.abs(v)} fill={v < 0 ? art.negative : i === 2 ? art.high : i === 3 ? art.low : i === 0 ? art.first : i === 5 ? art.last : art.series}/>);
      const pts = [[4, 36], [12, 30], [20, 38], [28, 26], [36, 33], [44, 28]];
      return <svg className="tile-art tile-art-sparkline" viewBox="0 0 48 44" width={48} height={44} aria-hidden="true" focusable="false">
        <g transform="translate(0,2)">{bars}</g>
        <polyline points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={art.series} strokeWidth={1.4}/>
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === 3 ? 2.4 : i === 2 ? 2.4 : i === 0 || i === 5 ? 2.4 : 1.6} fill={i === 3 ? art.high : i === 2 ? art.low : i === 0 ? art.first : i === 5 ? art.last : art.markers}/>)}
      </svg>;
    }
    case 'texture': return <TextureArt id={art.id}/>;
    case 'textStyle': {
      // A text style as it looks (Home > Styles): its sample in its own font, size, weight and colour on paper, its name underneath.
      const px = Math.max(10, Math.min(17, (art.size ?? 11) * 1.1));
      return <span className="tile-art tile-art-textstyle" aria-hidden="true" style={{display: 'grid', gridTemplateRows: '1fr auto', width: 70, height: 52, boxSizing: 'border-box', padding: '4px 3px 3px', borderRadius: 4, background: '#fff', border: '1px solid rgba(128,128,128,.45)', overflow: 'hidden', textAlign: 'center'}}>
        <span style={{alignSelf: 'center', whiteSpace: 'nowrap', overflow: 'hidden', fontFamily: face(art.font), fontSize: px, fontWeight: art.bold ? 700 : 400, fontStyle: art.italic ? 'italic' : 'normal', color: art.color ?? '#1b1b1d', textTransform: art.caps ? 'uppercase' : undefined, fontVariant: art.smallCaps ? 'small-caps' : undefined,
          textDecoration: [art.underline ? 'underline' : '', art.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined, letterSpacing: art.spacing ? `${art.spacing}px` : undefined}}>{art.sample ?? 'AaBbCc'}</span>
        <span style={{fontSize: 9.5, color: '#44464d', fontFamily: "var(--ark-font, 'Segoe UI'), sans-serif", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{art.label}</span>
      </span>;
    }
    case 'chart': {
      // A column chart in miniature (Chart Styles, Quick Layout): bars in the palette, gridlines, data labels, a legend, axis titles.
      const w = 64, h = 48, lg = art.legend ?? 'none';
      const px = lg === 'left' ? 16 : 4, pr = lg === 'right' ? 16 : 4, pt = lg === 'top' ? 11 : 4, pb = (lg === 'bottom' ? 11 : 4) + (art.axes ? 5 : 0);
      const x0 = px + (art.axes ? 5 : 0), x1 = w - pr, y0 = pt, y1 = h - pb;
      const hs = [0.55, 0.85, 0.4, 0.7], n = Math.min(4, Math.max(2, art.colors.length + 1)), bw = (x1 - x0) / (n * 1.6);
      // The tile follows the chart's type: columns, bars, a line, an area, a pie or doughnut, scatter points.
      const kind = /^bar/.test(art.type ?? '') ? 'bar' : /^line/.test(art.type ?? '') ? 'line' : /^area/.test(art.type ?? '') ? 'area' : art.type === 'pie' || art.type === 'doughnut' ? 'pie' : /^scatter/.test(art.type ?? '') ? 'scatter' : 'column';
      const col = (i: number) => art.colors[i % art.colors.length] ?? '#888';
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rad = Math.min(x1 - x0, y1 - y0) / 2 - 1;
      const slice = (a0: number, a1: number) => `M${cx},${cy} L${cx + rad * Math.cos(a0)},${cy + rad * Math.sin(a0)} A${rad},${rad} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${cx + rad * Math.cos(a1)},${cy + rad * Math.sin(a1)} Z`;
      const lines = [[0.6, 0.35, 0.5, 0.2], [0.35, 0.6, 0.25, 0.5]];
      const lp = (s: number) => lines[s % 2].map((v, i) => `${x0 + 2 + (i * (x1 - x0 - 4)) / 3},${y1 - (y1 - y0) * v}`).join(' ');
      const legend = lg === 'none' ? null : lg === 'top' || lg === 'bottom'
        ? art.colors.slice(0, 3).map((c, i) => <rect key={i} x={w / 2 - 14 + i * 10} y={lg === 'top' ? 3 : h - 6} width={6} height={3} fill={c}/>)
        : art.colors.slice(0, 3).map((c, i) => <rect key={i} x={lg === 'left' ? 3 : w - 12} y={14 + i * 7} width={8} height={3} fill={c}/>);
      return <svg className="tile-art tile-art-chart" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.55)"/>
        {art.grid && kind !== 'pie' ? [0, 1, 2, 3].map(i => <line key={i} x1={x0} x2={x1} y1={y0 + ((y1 - y0) * i) / 3} y2={y0 + ((y1 - y0) * i) / 3} stroke="#d4d4d4" strokeWidth={0.6}/>) : null}
        {kind === 'column' ? Array.from({length: n}, (_, i) => {
          const bh = (y1 - y0) * hs[i % 4], bx = x0 + 2 + i * ((x1 - x0 - 2) / n);
          return <g key={i}><rect x={bx} y={y1 - bh} width={bw} height={bh} fill={col(i)}/>{art.labels ? <rect x={bx + 1} y={y1 - bh - 4} width={bw - 2} height={2} fill="#555"/> : null}</g>;
        }) : null}
        {kind === 'bar' ? Array.from({length: n}, (_, i) => {
          const bl = (x1 - x0 - 2) * hs[i % 4], bh = (y1 - y0) / (n * 1.5), by = y0 + 1 + i * ((y1 - y0 - 1) / n);
          return <g key={i}><rect x={x0} y={by} width={bl} height={bh} fill={col(i)}/>{art.labels ? <rect x={x0 + bl + 1} y={by + bh / 2 - 1} width={4} height={2} fill="#555"/> : null}</g>;
        }) : null}
        {kind === 'line' ? [0, 1].map(s => <g key={s}><polyline points={lp(s)} fill="none" stroke={col(s)} strokeWidth={1.6} strokeLinejoin="round"/>
          {art.labels ? lines[s].map((v, i) => <rect key={i} x={x0 + (i * (x1 - x0 - 4)) / 3} y={y1 - (y1 - y0) * v - 5} width={4} height={2} fill="#555"/>) : null}</g>) : null}
        {kind === 'area' ? [1, 0].map(s => <polygon key={s} points={`${x0 + 2},${y1} ${lp(s)} ${x1 - 2},${y1}`} fill={col(s)} opacity={s ? 0.85 : 0.95}/>) : null}
        {kind === 'pie' ? [0.34, 0.27, 0.22, 0.17].reduce<{a: number; out: ReactElement[]}>((acc, f, i) => { const a1 = acc.a + f * Math.PI * 2; acc.out.push(<path key={i} d={slice(acc.a, a1)} fill={col(i)} stroke="#fff" strokeWidth={0.6}/>); acc.a = a1; return acc; }, {a: -Math.PI / 2, out: []}).out : null}
        {kind === 'pie' && art.type === 'doughnut' ? <circle cx={cx} cy={cy} r={rad * 0.5} fill="#fff"/> : null}
        {kind === 'scatter' ? [[0.2, 0.3], [0.4, 0.65], [0.55, 0.45], [0.72, 0.8], [0.85, 0.55], [0.3, 0.7]].map(([u, v], i) => <circle key={i} cx={x0 + 3 + u * (x1 - x0 - 6)} cy={y1 - 2 - v * (y1 - y0 - 4)} r={1.6} fill={col(i)}/>) : null}
        {art.axes ? <><rect x={x0} y={h - 8 + (lg === 'bottom' ? -6 : 0)} width={x1 - x0} height={2} fill="#999"/><rect x={3 + (lg === 'left' ? 12 : 0)} y={y0} width={2} height={y1 - y0} fill="#999"/></> : null}
        {legend}
      </svg>;
    }
    case 'tablestyle': return <TableStyleArt art={art}/>;
    case 'line': {
      // A border line style as it is drawn (Borders > Line Style): the dash pattern and the weight.
      const dash: Record<string, string> = {hair: '1 1', dotted: '1 2', dashDotDot: '6 2 1 2 1 2', dashDot: '6 2 1 2', dashed: '4 2', mediumDashDotDot: '6 2 1 2 1 2', slantDashDot: '6 2 2 2', mediumDashDot: '6 2 1 2', mediumDashed: '6 3'};
      const wide: Record<string, number> = {medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3};
      const c = art.color ?? 'currentColor';
      return <svg className="tile-art tile-art-line" viewBox="0 0 64 10" width={64} height={10} aria-hidden="true" focusable="false">
        {art.style === 'double'
          ? <g stroke={c} strokeWidth={1}><line x1={2} y1={3.5} x2={62} y2={3.5}/><line x1={2} y1={6.5} x2={62} y2={6.5}/></g>
          : <line x1={2} y1={5} x2={62} y2={5} stroke={c} strokeWidth={wide[art.style] ?? 1} strokeDasharray={dash[art.style]}/>}
      </svg>;
    }
    case 'cf': {
      // Conditional formatting in miniature (the Data Bars, Color Scales and Icon Sets menus): a few cells with what the rule draws in them.
      if (art.mode === 'iconSet') {
        const row = iconRow(art.set) as {d: string; fill?: string; stroke?: string; sw?: number}[][];
        const n = row.length, s = 13, g = 2, w = n * s + (n - 1) * g + 8, h = 22;
        return <svg className="tile-art tile-art-cf" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
          <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.55)"/>
          {row.map((shapes, i) => <g key={i} transform={`translate(${4 + i * (s + g)} ${(h - s) / 2}) scale(${s / 16})`}>
            {shapes.map((sh, j) => <path key={j} d={sh.d} fill={sh.fill ?? 'none'} stroke={sh.stroke} strokeWidth={sh.sw} strokeLinecap="round" strokeLinejoin="round"/>)}
          </g>)}
        </svg>;
      }
      const w = 44, h = 44;
      if (art.mode === 'colorScale') {
        const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
        const cols = art.colors.map(rgb);
        const at = (t: number) => {
          const k = (cols.length - 1) * t, i = Math.min(Math.floor(k), cols.length - 2), u = k - i;
          return `rgb(${[0, 1, 2].map(x => Math.round(cols[i][x] + (cols[i + 1][x] - cols[i][x]) * u)).join(',')})`;
        };
        const rows = 5;
        return <svg className="tile-art tile-art-cf" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
          <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.55)"/>
          {Array.from({length: rows}, (_, i) => <g key={i}>
            <rect x={3} y={3 + i * 7.6} width={w - 6} height={7.2} fill={at(i / (rows - 1))}/>
            <rect x={6} y={5.6 + i * 7.6} width={12} height={2} fill="#000" opacity={0.22}/>
          </g>)}
        </svg>;
      }
      const fr = [0.92, 0.58, 0.34, 0.74];
      const gid = `cfb${uid}`;
      return <svg className="tile-art tile-art-cf" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
        {art.gradient ? <defs><linearGradient id={gid} x1={0} y1={0} x2={1} y2={0}><stop offset={0} stopColor={art.color}/><stop offset={1} stopColor={art.color} stopOpacity={0.15}/></linearGradient></defs> : null}
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.55)"/>
        {fr.map((f, i) => <g key={i}>
          <rect x={4} y={4 + i * 9.6} width={(w - 8) * f} height={7.6} fill={art.gradient ? `url(#${gid})` : art.color} stroke={art.gradient ? undefined : art.color} strokeWidth={0.6}/>
          <rect x={6} y={6.8 + i * 9.6} width={9} height={2} fill="#000" opacity={0.28}/>
        </g>)}
      </svg>;
    }
    case 'pivot': {
      // A PivotTable style in miniature: the header row in its colour, three body rows with the style's lines, a banded filter row on top.
      const w = 52, h = 40, header = art.header ?? '#e8e8e8', line = art.line ?? '#999', band = art.band ?? '#f2f2f2';
      return <svg className="tile-art tile-art-pivot" viewBox={'0 0 ' + w + ' ' + h} width={w} height={h} aria-hidden="true" focusable="false">
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2} fill="#fff" stroke="rgba(128,128,128,.55)"/>
        <rect x={3} y={4} width={w - 6} height={5} fill={band}/>
        <rect x={3} y={11} width={w - 6} height={7} fill={header}/>
        <rect x={5} y={13} width={12} height={3} fill={art.text} opacity={0.75}/><rect x={24} y={13} width={9} height={3} fill={art.text} opacity={0.75}/><rect x={37} y={13} width={9} height={3} fill={art.text} opacity={0.75}/>
        {[0, 1, 2].map(i => <g key={i}><rect x={5} y={21 + i * 5} width={12} height={2} fill="#777"/><rect x={24} y={21 + i * 5} width={9} height={2} fill="#aaa"/><rect x={37} y={21 + i * 5} width={9} height={2} fill="#aaa"/><line x1={3} x2={w - 3} y1={19.5 + i * 5} y2={19.5 + i * 5} stroke={line} strokeWidth={0.5}/></g>)}
        <line x1={3} x2={w - 3} y1={h - 3.5} y2={h - 3.5} stroke={line} strokeWidth={1}/>
      </svg>;
    }
    case 'slicer': {
      // A slicer style in miniature: the header, the frame, one tile shown and two filtered out.
      const w = 36, h = 44;
      return <svg className="tile-art tile-art-slicer" viewBox={'0 0 ' + w + ' ' + h} width={w} height={h} aria-hidden="true" focusable="false">
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2} fill={art.body ?? '#fff'} stroke={art.frame ?? '#999'}/>
        <rect x={1} y={1} width={w - 2} height={9} rx={1.5} fill={art.header ?? '#ddd'}/>
        <rect x={4} y={4} width={14} height={3} fill={art.headerText ?? '#fff'} opacity={0.85}/>
        <rect x={4} y={13} width={w - 8} height={8} rx={1} fill={art.on ?? '#bcd'} stroke={art.onLine ?? '#789'} strokeWidth={0.6}/>
        <rect x={7} y={16} width={12} height={2} fill={art.onText ?? '#222'} opacity={0.8}/>
        {[0, 1].map(i => <g key={i}><rect x={4} y={23 + i * 9} width={w - 8} height={8} rx={1} fill={art.off ?? '#eee'} stroke={art.offLine ?? '#ccc'} strokeWidth={0.6}/><rect x={7} y={26 + i * 9} width={10} height={2} fill={art.offText ?? '#888'} opacity={0.8}/></g>)}
      </svg>;
    }
    case 'table': {
      // A table style in miniature: the header row in its colour, rows banded as the style bands them, the style's lines.
      const w = 44, h = 36, line = art.line ?? '#9a9a9a';
      return <svg className="tile-art tile-art-table" viewBox={'0 0 ' + w + ' ' + h} width={w} height={h} aria-hidden="true" focusable="false">
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={1.5} fill="#fff" stroke="rgba(128,128,128,.55)"/>
        <rect x={2} y={3} width={w - 4} height={7} fill={art.header ?? '#fff'}/>
        {[0, 1, 2, 3].map(i => <rect key={i} x={2} y={11 + i * 6} width={w - 4} height={6} fill={i % 2 === 0 ? art.band ?? art.body ?? '#fff' : art.body ?? '#fff'}/>)}
        {[0, 1, 2, 3, 4].map(i => <line key={i} x1={2} x2={w - 2} y1={10.5 + i * 6} y2={10.5 + i * 6} stroke={line} strokeWidth={0.5}/>)}
        <rect x={5} y={5} width={10} height={3} fill={art.text} opacity={0.8}/><rect x={20} y={5} width={8} height={3} fill={art.text} opacity={0.8}/><rect x={32} y={5} width={8} height={3} fill={art.text} opacity={0.8}/>
        {[0, 1, 2, 3].map(i => <g key={i}><rect x={5} y={13 + i * 6} width={10} height={2} fill="#777"/><rect x={20} y={13 + i * 6} width={8} height={2} fill="#aaa"/><rect x={32} y={13 + i * 6} width={8} height={2} fill="#aaa"/></g>)}
      </svg>;
    }
    case 'theme': {
      const w = 76, h = 52, gap = 1.5, bw = (w - 12 - gap * 5) / 6;
      return <svg className="tile-art tile-art-theme" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill={art.bg} stroke="rgba(128,128,128,.55)"/>
        <text x={9} y={26} fontSize={21} fill={art.fg} fontFamily={face(art.font)}>Aa</text>
        {art.accents.slice(0, 6).map((c, i) => <rect key={i} x={6 + i * (bw + gap)} y={h - 14} width={bw} height={7} fill={c}/>)}
      </svg>;
    }
    case 'diagram':
      return <span className="tile-art tile-art-diagram" style={{display: 'block', width: 80, height: 50, borderRadius: 3, overflow: 'hidden'}} aria-hidden="true"><DiagramArt items={art.items} w={160} h={100}/></span>;
    case 'colors':
      return <svg className="tile-art tile-art-colors" viewBox="0 0 104 16" width={104} height={16} aria-hidden="true" focusable="false">
        {art.colors.slice(0, 8).map((c, i) => <rect key={i} x={i * 13} y={1} width={12} height={14} fill={c} stroke="rgba(128,128,128,.5)" strokeWidth={0.6}/>)}
      </svg>;
    case 'fonts':
      return <span className="tile-art tile-art-fonts" aria-hidden="true">
        <span style={{fontFamily: face(art.major), fontWeight: 600}}>Aa</span><span style={{fontFamily: face(art.minor)}}>Aa</span>
      </span>;
    case 'effect': {
      const s = art.shadow, id = `fx${uid}`;
      return <svg className="tile-art tile-art-effect" viewBox="0 0 40 32" width={40} height={32} aria-hidden="true" focusable="false">
        <defs>
          {s ? <filter id={id} x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx={0} dy={Math.min(s.dist, 6) * 0.6} stdDeviation={Math.max(Math.min(s.blur, 16) / 4, 0.4)} floodColor="#000" floodOpacity={Math.min(Math.max(s.alpha, 0.15), 0.8)}/></filter> : null}
          {art.glow ? <filter id={id} x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx={0} dy={0} stdDeviation={Math.min(art.glow, 14) / 3} floodColor="#4f8cf0" floodOpacity={0.9}/></filter> : null}
        </defs>
        <rect x={9} y={7} width={22} height={16} rx={2} fill={art.flat ? '#4f8cf0' : '#6a9df2'} stroke="#26498c" strokeWidth={Math.min(Math.max(art.line, 0.5), 3) * 0.9}
          filter={s || art.glow ? `url(#${id})` : undefined}/>
      </svg>;
    }
    case 'bgstyle': {
      const id = `bg${uid}`;
      const stops = art.stops;
      const ang = ((art.angle ?? 90) * Math.PI) / 180;
      const dx = Math.cos(ang) / 2, dy = Math.sin(ang) / 2;
      return <svg className="tile-art tile-art-bg" viewBox="0 0 44 32" width={44} height={32} aria-hidden="true" focusable="false">
        {stops ? <defs><linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>{stops.map(([p, c], i) => <stop key={i} offset={p} stopColor={c}/>)}</linearGradient></defs> : null}
        <rect x={0.5} y={0.5} width={43} height={31} rx={2} fill={stops ? `url(#${id})` : art.color} stroke="rgba(128,128,128,.6)"/>
      </svg>;
    }
    case 'pictureStyle': {
      // A sample picture (sky, sun, hill) in one of Picture Format's five styles: the frame, the rounded or feathered edge, the shadow.
      const id = `ps${uid}`, st = art.style;
      const w = 56, h = 44, m = st === 'simpleFrame' ? 5 : st === 'thickFrame' ? 7 : st === 'shadow' ? 6 : 6;
      const x0 = m, y0 = m, iw = w - m * 2 - (st === 'shadow' ? 3 : 0), ih = h - m * 2 - (st === 'shadow' ? 3 : 0);
      const rx = st === 'rounded' ? 7 : 0;
      return <svg className="tile-art tile-art-picture" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={`${id}c`}><rect x={x0} y={y0} width={iw} height={ih} rx={rx}/></clipPath>
          {st === 'softEdge' ? <filter id={`${id}s`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation={2.4}/></filter> : null}
          {st === 'softEdge' ? <mask id={`${id}m`}><rect x={x0 + 3} y={y0 + 3} width={iw - 6} height={ih - 6} fill="#fff" filter={`url(#${id}s)`}/></mask> : null}
          {st === 'shadow' ? <filter id={`${id}d`} x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx={2} dy={2} stdDeviation={1.6} floodColor="#000" floodOpacity={0.55}/></filter> : null}
        </defs>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={3} fill="#fff" stroke="rgba(128,128,128,.4)"/>
        {st === 'simpleFrame' || st === 'thickFrame' ? <rect x={x0 - m} y={y0 - m} width={iw + m * 2} height={ih + m * 2} fill="#fff" stroke={st === 'thickFrame' ? '#282828' : 'rgba(128,128,128,.55)'} strokeWidth={st === 'thickFrame' ? 1.6 : 0.8}/> : null}
        <g clipPath={`url(#${id}c)`} mask={st === 'softEdge' ? `url(#${id}m)` : undefined} filter={st === 'shadow' ? `url(#${id}d)` : undefined}>
          <rect x={x0} y={y0} width={iw} height={ih} fill="#a9d1f2"/>
          <circle cx={x0 + iw * 0.72} cy={y0 + ih * 0.3} r={ih * 0.14} fill="#f6d35b"/>
          <path d={`M${x0} ${y0 + ih} L${x0} ${y0 + ih * 0.66} Q${x0 + iw * 0.3} ${y0 + ih * 0.38} ${x0 + iw * 0.55} ${y0 + ih * 0.68} T${x0 + iw} ${y0 + ih * 0.6} L${x0 + iw} ${y0 + ih} Z`} fill="#5b9a4a"/>
        </g>
      </svg>;
    }
    case 'shapeStyle': {
      // A shape in a Shape Styles style: its fill, outline and shadow.
      const id = `ss${uid}`, rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
      return <svg className="tile-art tile-art-shapestyle" viewBox="0 0 44 30" width={44} height={30} aria-hidden="true" focusable="false">
        {art.shadow ? <defs><filter id={id} x="-30%" y="-30%" width="170%" height="190%"><feDropShadow dx={1.4} dy={1.8} stdDeviation={1.2} floodColor="#000" floodOpacity={0.5}/></filter></defs> : null}
        <rect x={5} y={5} width={34} height={19} rx={2} fill={art.fill ? rgb(art.fill) : 'none'} stroke={art.line ? rgb(art.line) : 'none'} strokeWidth={art.line ? Math.min(art.lineWidth * 1.4, 3) : 0} filter={art.shadow ? `url(#${id})` : undefined}/>
      </svg>;
    }
    case 'gradient': {
      // A gradient fill (Shape Fill › Gradient variations), as the shape would be painted.
      const id = `gr${uid}`, f = art.fill ?? {}, rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
      const path = f.kind?.type === 'path';
      const ang = ((f.kind?.angle ?? 90) * Math.PI) / 180, dx = Math.cos(ang) / 2, dy = Math.sin(ang) / 2;
      const [fl, ft] = path ? [(f.kind.focus?.[0] ?? 50) / 100, (f.kind.focus?.[1] ?? 50) / 100] : [0.5, 0.5];
      return <svg className="tile-art tile-art-gradient" viewBox="0 0 36 26" width={36} height={26} aria-hidden="true" focusable="false">
        <defs>{path
          ? <radialGradient id={id} cx={fl} cy={ft} r={0.75}>{(f.stops ?? []).map((s: any, i: number) => <stop key={i} offset={s.pos / 100} stopColor={rgb(s.color)}/>)}</radialGradient>
          : <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>{(f.stops ?? []).map((s: any, i: number) => <stop key={i} offset={s.pos / 100} stopColor={rgb(s.color)}/>)}</linearGradient>}</defs>
        <rect x={0.5} y={0.5} width={35} height={25} rx={2} fill={`url(#${id})`} stroke="rgba(128,128,128,.6)"/>
      </svg>;
    }
    case 'wordArt': {
      // The letter A in one of the WordArt styles: its fill, outline, shadow, glow and reflection.
      const id = `wa${uid}`, fx = art.effects ?? {}, rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
      const fill = fx.fill?.type === 'none' ? 'none' : fx.fill?.type === 'gradient' ? `url(#${id}g)` : fx.fill?.color ? rgb(fx.fill.color) : '#222';
      const sh = fx.shadow, gl = fx.glow;
      // The letter sits on a chip that contrasts with it (light chip for dark letters, dark chip for light ones), so no style is lost in the tile.
      const lum = (c?: number[]) => (c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : 0.2);
      const tone = fx.fill?.type === 'gradient' && fx.fill.stops?.length ? fx.fill.stops.reduce((a: number, s: any) => a + lum(s.color), 0) / fx.fill.stops.length : fx.fill?.type === 'none' ? lum(fx.outline?.color) : lum(fx.fill?.color);
      const chip = tone > 0.62 ? '#2f323a' : '#ffffff';
      return <svg className="tile-art tile-art-wordart" viewBox="0 0 44 40" width={44} height={40} aria-hidden="true" focusable="false">
        <rect x={1} y={1} width={42} height={38} rx={5} fill={chip} stroke="rgba(128,128,128,.5)"/>
        <defs>
          {fx.fill?.type === 'gradient' ? <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">{fx.fill.stops.map((s: any, i: number) => <stop key={i} offset={s.pos / 100} stopColor={rgb(s.color)}/>)}</linearGradient> : null}
          {sh ? <filter id={`${id}s`} x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx={1.6} dy={1.6} stdDeviation={1} floodColor="#000" floodOpacity={0.55}/></filter> : null}
          {gl ? <filter id={`${id}l`} x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx={0} dy={0} stdDeviation={2.2} floodColor={rgb(gl.color)} floodOpacity={0.9}/></filter> : null}
        </defs>
        <text x={22} y={fx.reflection ? 22 : 29} textAnchor="middle" fontSize={26} fontWeight={700} fontFamily="'Segoe UI', sans-serif" fill={fill}
          stroke={fx.outline?.color ? rgb(fx.outline.color) : undefined} strokeWidth={fx.outline?.color ? Math.max(0.6, Math.min(fx.outline.width ?? 0.75, 2)) : undefined}
          filter={gl ? `url(#${id}l)` : sh ? `url(#${id}s)` : undefined}>A</text>
        {fx.reflection ? <text x={22} y={24} textAnchor="middle" fontSize={26} fontWeight={700} fontFamily="'Segoe UI', sans-serif" fill={fill === 'none' ? '#999' : fill} opacity={0.3} transform="translate(0 51) scale(1 -1)">A</text> : null}
      </svg>;
    }
    case 'artistic': {
      // Picture Format › Artistic Effects: a small landscape drawn through an SVG filter that mimics the effect.
      const f = `ar${uid}`, edge = '-1 -1 -1 -1 8 -1 -1 -1 -1', e = art.effect;
      const gray = <feColorMatrix type="saturate" values="0"/>;
      const invert = (k: number) => <feComponentTransfer><feFuncR type="linear" slope={-k} intercept="1"/><feFuncG type="linear" slope={-k} intercept="1"/><feFuncB type="linear" slope={-k} intercept="1"/></feComponentTransfer>;
      const steps = (t: string) => <feComponentTransfer><feFuncR type="discrete" tableValues={t}/><feFuncG type="discrete" tableValues={t}/><feFuncB type="discrete" tableValues={t}/></feComponentTransfer>;
      const body = e === 'artisticBlur' ? <feGaussianBlur stdDeviation="1.6"/>
        : e === 'artisticPencilGrayscale' ? <>{gray}<feConvolveMatrix order="3" kernelMatrix={edge} preserveAlpha="true"/>{invert(2)}</>
          : e === 'artisticLineDrawing' ? <>{gray}<feConvolveMatrix order="3" kernelMatrix={edge} preserveAlpha="true"/>{invert(3)}{steps('0 1 1 1')}</>
            : e === 'artisticPhotocopy' ? <>{gray}<feConvolveMatrix order="3" kernelMatrix={edge} preserveAlpha="true"/>{invert(4)}{steps('0 1')}</>
              : e === 'artisticCutout' ? steps('0 0.33 0.66 1')
                : e === 'artisticGlowEdges' ? <><feConvolveMatrix order="3" kernelMatrix={edge} preserveAlpha="true"/><feComponentTransfer><feFuncR type="linear" slope="2.5"/><feFuncG type="linear" slope="2.5"/><feFuncB type="linear" slope="2.5"/></feComponentTransfer></>
                  : <><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="3" result="n"/><feColorMatrix in="n" type="saturate" values="0" result="g"/><feComposite in="SourceGraphic" in2="g" operator="arithmetic" k1="0" k2="0.8" k3="0.55" k4="-0.2"/></>;
      return <svg className="tile-art tile-art-artistic" viewBox="0 0 56 40" width={56} height={40} aria-hidden="true" focusable="false">
        <defs><filter id={f} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">{body}</filter><clipPath id={`${f}c`}><rect x={0} y={0} width={56} height={40} rx={2}/></clipPath></defs>
        <g clipPath={`url(#${f}c)`}><g filter={`url(#${f})`}>
          <rect width={56} height={40} fill="#8fc4ee"/><circle cx={42} cy={12} r={6} fill="#ffd45c"/><path d="M0 40V26q10-9 20-3t18-4q10-3 18 5V40Z" fill="#5a9e4a"/><path d="M0 40v-8q14-6 28 0t28-3v11Z" fill="#3f7a3a"/><path d="M12 24l4-8 4 8Z" fill="#8a6a45"/>
        </g></g>
        <rect x={0.5} y={0.5} width={55} height={39} rx={2} fill="none" stroke="rgba(128,128,128,.55)"/>
      </svg>;
    }
    case 'shape3d': return <Shape3dTile art={art} uid={'s3' + uid}/>;
    default: return null;
  }
}
