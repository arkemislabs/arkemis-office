// Shape effects and picture corrections drawn on the slide: outer and inner shadow, glow, soft
// edges, reflection and bevel around a shape's art, and a picture's brightness, contrast,
// saturation, recolor (grayscale, duotone, black and white) and transparent colour. They are SVG
// filters over the shape's own drawing, so a thumbnail, the show and an export draw them too.
// The numbers follow deckcraft crates/render/src/images.rs apply_adjust (measured on
// PowerPoint's export) and renderer.rs / geometry.rs shadow_local (shadow offset, scale, skew);
// the look of glow, soft edges and bevel approximates the raster renderer's.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {ReactNode} from 'react';
import {ctxColor, effects as resolveEffects} from '../../../../core/prism/model/resolve.mjs';

type Any = any;
let uid = 0;
const nid = (p: string) => `${p}${(++uid).toString(36)}`;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const f3 = (v: number) => +v.toFixed(3);
const rgb = (c: Any) => `rgb(${c.r},${c.g},${c.b})`;
const alpha = (c: Any) => +((c.a ?? 255) / 255).toFixed(4);

/** The bevel's width and height in points from kept `a:bevelT` XML (6 pt when it has none). */
export function bevelSize(fx: Any): {w: number; h: number} {
  const m = typeof fx?.raw3d === 'string' ? /<a:bevelT\b([^>]*)>/.exec(fx.raw3d) : null;
  const at = (n: string) => { const v = m ? new RegExp(`\\b${n}="(\\d+)"`).exec(m[1]) : null; return v ? Number(v[1]) / 12700 : 6; };
  return {w: at('w'), h: at('h')};
}

/** Whether a resolved effects object draws anything on the slide. */
export function drawsEffects(fx: Any): boolean {
  return !!fx && !!(fx.outerShadow || fx.innerShadow || (fx.glow && num(fx.glow.radius) > 0) || num(fx.softEdge) > 0 || fx.reflection || fx.bevel);
}

interface Layers {
  /** Drawn before the shape: shadow, glow. */
  before: ReactNode[];
  /** Drawn after the shape: inner shadow and the reflection. */
  after: ReactNode[];
  /** Filters wrapped round the shape's own art, outermost first. */
  filters: string[];
}

const mapLinear = (m: number[]) => ({a: m[0], b: m[1], c: m[2], d: m[3]});

/**
 * The extra layers a shape's effects add. `coreId` is the id of the element holding the shape's own
 * art; the layers are `<use>`s of it. `m` is the shape's local-to-slide matrix (a shadow's offset is
 * in slide space), `w` and `h` the shape's size.
 */
export function effectLayers(ctx: Any, sh: Any, m: number[], w: number, h: number, defs: ReactNode[], coreId: string): Layers | null {
  const [fx, ph] = resolveEffects(ctx, sh) as [Any, Any];
  if (!drawsEffects(fx)) return null;
  const out: Layers = {before: [], after: [], filters: []};
  const col = (c: Any) => ctxColor(ctx, c, ph);
  const pad = (v: number) => Math.max(8, Math.ceil(v));
  const region = (p: number, extra: Record<string, number> = {}) =>
    ({filterUnits: 'userSpaceOnUse' as const, x: -p + (extra.x ?? 0), y: -p + (extra.y ?? 0), width: w + 2 * p, height: h + 2 * p, colorInterpolationFilters: 'sRGB' as const});
  const lin = mapLinear(m);
  const det = lin.a * lin.d - lin.b * lin.c || 1;
  // A slide-space vector as the shape's own space sees it.
  const local = (dx: number, dy: number): [number, number] => [(lin.d * dx - lin.c * dy) / det, (-lin.b * dx + lin.a * dy) / det];

  if (num(fx.softEdge) > 0) {
    const id = nid('fs'), r = Math.min(num(fx.softEdge), Math.min(w, h) / 2);
    defs.push(<filter key={id} id={id} {...region(4)}>
      <feMorphology in="SourceAlpha" operator="erode" radius={f3(r / 2)} result="e"/>
      <feGaussianBlur in="e" stdDeviation={f3(Math.max(r / 2, 0.3))} result="m"/>
      <feComposite in="SourceGraphic" in2="m" operator="in"/>
    </filter>);
    out.filters.push(id);
  }
  if (fx.bevel) {
    const id = nid('fb'), {w: bw, h: bh} = bevelSize(fx);
    const r = Math.max(Math.min(bw, Math.min(w, h) / 2), 0.5);
    defs.push(<filter key={id} id={id} {...region(4)}>
      <feGaussianBlur in="SourceAlpha" stdDeviation={f3(r / 2)} result="b"/>
      <feSpecularLighting in="b" surfaceScale={f3(Math.min(Math.max(bh, 1), 14) * 0.9)} specularConstant="0.7" specularExponent="18" lightingColor="#ffffff" result="s">
        <feDistantLight azimuth="225" elevation="48"/>
      </feSpecularLighting>
      <feComposite in="s" in2="SourceAlpha" operator="in" result="sa"/>
      <feDiffuseLighting in="b" surfaceScale={f3(Math.min(Math.max(bh, 1), 14) * 0.9)} diffuseConstant="1.15" lightingColor="#ffffff" result="d">
        <feDistantLight azimuth="225" elevation="52"/>
      </feDiffuseLighting>
      <feComposite in="SourceGraphic" in2="d" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit"/>
      <feComposite in="lit" in2="sa" operator="arithmetic" k1="0" k2="1" k3="0.6" k4="0" result="both"/>
      <feComposite in="both" in2="SourceAlpha" operator="in"/>
    </filter>);
    out.filters.push(id);
  }

  const sh1 = fx.outerShadow;
  if (sh1) {
    const id = nid('fo'), c = col(sh1.color);
    const dist = num(sh1.dist), dir = (num(sh1.dir) * Math.PI) / 180;
    const [dx, dy] = local(Math.cos(dir) * dist, Math.sin(dir) * dist);
    const blur = num(sh1.blur), sx = num(sh1.sx, 1), sy = num(sh1.sy, 1), kx = num(sh1.kx), ky = num(sh1.ky);
    const align = String(sh1.align ?? 'b');
    const ax = align.includes('l') ? 0 : align.includes('r') ? w : w / 2, ay = align.includes('t') ? 0 : align.includes('b') ? h : h / 2;
    const tf = `translate(${f3(dx)} ${f3(dy)}) translate(${f3(ax)} ${f3(ay)}) skewX(${f3(kx)}) skewY(${f3(ky)}) scale(${f3(sx)} ${f3(sy)}) translate(${f3(-ax)} ${f3(-ay)})`;
    defs.push(<filter key={id} id={id} {...region(pad(blur * 2 + dist + Math.abs(sy - 1) * h))}>
      <feGaussianBlur in="SourceAlpha" stdDeviation={f3(blur / 2)} result="b"/>
      <feFlood floodColor={rgb(c)} floodOpacity={alpha(c)} result="c"/>
      <feComposite in="c" in2="b" operator="in"/>
    </filter>);
    out.before.push(<use key={id} href={`#${coreId}`} filter={`url(#${id})`} transform={tf}/>);
  }
  const gl = fx.glow;
  if (gl && num(gl.radius) > 0) {
    const id = nid('fg'), c = col(gl.color), r = num(gl.radius);
    defs.push(<filter key={id} id={id} {...region(pad(r * 2))}>
      <feMorphology in="SourceAlpha" operator="dilate" radius={f3(r / 2)} result="d"/>
      <feGaussianBlur in="d" stdDeviation={f3(r / 2)} result="b"/>
      <feFlood floodColor={rgb(c)} floodOpacity={alpha(c)} result="c"/>
      <feComposite in="c" in2="b" operator="in"/>
    </filter>);
    out.before.push(<use key={id} href={`#${coreId}`} filter={`url(#${id})`}/>);
  }
  const inner = fx.innerShadow;
  if (inner) {
    const id = nid('fi'), c = col(inner.color);
    const dist = num(inner.dist), dir = (num(inner.dir) * Math.PI) / 180;
    const [dx, dy] = local(Math.cos(dir) * dist, Math.sin(dir) * dist);
    defs.push(<filter key={id} id={id} {...region(4)}>
      <feComponentTransfer in="SourceAlpha" result="inv"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>
      <feOffset in="inv" dx={f3(dx)} dy={f3(dy)} result="o"/>
      <feGaussianBlur in="o" stdDeviation={f3(num(inner.blur) / 2)} result="b"/>
      <feFlood floodColor={rgb(c)} floodOpacity={alpha(c)} result="c"/>
      <feComposite in="c" in2="b" operator="in" result="s"/>
      <feComposite in="s" in2="SourceAlpha" operator="in"/>
    </filter>);
    out.after.push(<use key={id} href={`#${coreId}`} filter={`url(#${id})`}/>);
  }
  const rf = fx.reflection;
  if (rf) {
    const id = nid('fr'), mask = nid('rm'), grad = nid('rg');
    const dist = num(rf.dist), end = Math.min(Math.max(num(rf.endPos, 0.35), 0.01), 1);
    const start = Math.min(Math.max(num(rf.startAlpha, 0.5), 0), 1), stop = Math.min(Math.max(num(rf.endAlpha), 0), 1);
    const top = h + dist;
    defs.push(<linearGradient key={grad} id={grad} gradientUnits="userSpaceOnUse" x1="0" y1={f3(top)} x2="0" y2={f3(top + end * h)}>
      <stop offset="0" stopColor="#fff" stopOpacity={f3(start)}/><stop offset="1" stopColor="#fff" stopOpacity={f3(stop)}/>
    </linearGradient>);
    defs.push(<mask key={mask} id={mask} maskUnits="userSpaceOnUse" x={-w} y={f3(top)} width={f3(3 * w)} height={f3(Math.max(end * h, 1))}>
      <rect x={-w} y={f3(top)} width={f3(3 * w)} height={f3(Math.max(end * h, 1))} fill={`url(#${grad})`}/>
    </mask>);
    if (num(rf.blur) > 0) {
      defs.push(<filter key={id} id={id} {...region(pad(num(rf.blur) * 2), {y: h})}><feGaussianBlur stdDeviation={f3(Math.min(num(rf.blur), 4) / 2)}/></filter>);
    }
    out.after.push(<g key={`${id}g`} mask={`url(#${mask})`}>
      <use href={`#${coreId}`} transform={`translate(0 ${f3(2 * h + dist)}) scale(1 -1)`} filter={num(rf.blur) > 0 ? `url(#${id})` : undefined}/>
    </g>);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Picture corrections and recolor

/** Whether a picture's adjust changes how it is drawn. */
export function drawsAdjust(a: Any): boolean {
  return !!a && (num(a.brightness) !== 0 || num(a.contrast) !== 0 || (a.saturation != null && a.saturation !== 1) || !!a.grayscale || !!a.duotone || a.bilevel != null || !!a.clearColor || !!a.alphaInv);
}

/** The id of an SVG filter that draws a picture with its corrections, or null when it needs none. */
export function adjustFilter(ctx: Any, a: Any, defs: ReactNode[]): string | null {
  if (!drawsAdjust(a)) return null;
  const id = nid('fa');
  const kids: ReactNode[] = [];
  let last = 'SourceGraphic';
  const step = (node: ReactNode, name: string) => { kids.push(node); last = name; };
  if (a.clearColor) {
    const c = a.clearColor, band = (v: number) => Array.from({length: 256}, (_, i) => (Math.abs(i - v) < 8 ? 1 : 0)).join(' ');
    step(<feComponentTransfer key="cb" in={last} result="cb"><feFuncR type="discrete" tableValues={band(c.r)}/><feFuncG type="discrete" tableValues={band(c.g)}/>
      <feFuncB type="discrete" tableValues={band(c.b)}/></feComponentTransfer>, 'cb');
    kids.push(<feColorMatrix key="cr" in="cb" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="cr"/>);
    kids.push(<feColorMatrix key="cg" in="cb" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 1 0 0 0" result="cg"/>);
    kids.push(<feColorMatrix key="cl" in="cb" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0" result="cl"/>);
    kids.push(<feComposite key="c1" in="cr" in2="cg" operator="in" result="c1"/>);
    kids.push(<feComposite key="c2" in="c1" in2="cl" operator="in" result="c2"/>);
    step(<feComposite key="cx" in="SourceGraphic" in2="c2" operator="out" result="cx"/>, 'cx');
  }
  const sat = a.grayscale ? 0 : a.saturation == null ? 1 : num(a.saturation, 1);
  if (sat !== 1) step(<feColorMatrix key="sat" in={last} type="saturate" values={String(f3(Math.min(Math.max(sat, 0), 4)))} result="sat"/>, 'sat');
  const b = Math.min(Math.max(num(a.brightness), -1), 1) * 255, cn = Math.min(Math.max(num(a.contrast), -1), 1);
  if (b !== 0 || cn !== 0) {
    const cf = cn >= 0 ? 1 / (1 - cn * 0.99) : 1 + cn;
    const icpt = (127.5 * (1 - cf) + (b * (1 + cf)) / 2) / 255;
    step(<feComponentTransfer key="bc" in={last} result="bc"><feFuncR type="linear" slope={f3(cf)} intercept={f3(icpt)}/><feFuncG type="linear" slope={f3(cf)} intercept={f3(icpt)}/>
      <feFuncB type="linear" slope={f3(cf)} intercept={f3(icpt)}/></feComponentTransfer>, 'bc');
  }
  const duo = Array.isArray(a.duotone) && a.duotone.length === 2 ? a.duotone.map((c: Any) => ctxColor(ctx, c, null)) : null;
  if (duo) {
    const [d, l] = duo;
    kids.push(<feColorMatrix key="lum" in={last} type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" result="lum"/>);
    step(<feComponentTransfer key="duo" in="lum" result="duo">
      <feFuncR type="linear" slope={f3((l.r - d.r) / 255)} intercept={f3(d.r / 255)}/><feFuncG type="linear" slope={f3((l.g - d.g) / 255)} intercept={f3(d.g / 255)}/>
      <feFuncB type="linear" slope={f3((l.b - d.b) / 255)} intercept={f3(d.b / 255)}/></feComponentTransfer>, 'duo');
  }
  if (a.bilevel != null) {
    const t = Math.min(Math.max(num(a.bilevel), 0), 1);
    const table = Array.from({length: 256}, (_, i) => (i >= t * 255 ? 1 : 0)).join(' ');
    kids.push(<feColorMatrix key="bl" in={last} type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" result="bl"/>);
    step(<feComponentTransfer key="bw" in="bl" result="bw"><feFuncR type="discrete" tableValues={table}/><feFuncG type="discrete" tableValues={table}/>
      <feFuncB type="discrete" tableValues={table}/></feComponentTransfer>, 'bw');
  }
  if (a.alphaInv) step(<feComponentTransfer key="ai" in={last} result="ai"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>, 'ai');
  defs.push(<filter key={id} id={id} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">{kids}</filter>);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Sketched outlines (Shape Outline > Sketched): the stroke displaced by noise, so the line wobbles as if drawn by hand. PowerPoint's behaviour, not checked against upstream.

const SKETCH = {curved: {freq: 0.012, octaves: 1, scale: 2.6}, freehand: {freq: 0.03, octaves: 2, scale: 4.2}, scribble: {freq: 0.06, octaves: 3, scale: 6.4}} as Record<string, {freq: number; octaves: number; scale: number}>;

/** The filter that makes a stroke look hand-drawn in `style`; added to `defs`; its id. The same shape always wobbles the same way (the seed is its id). */
export function sketchFilter(style: string, seed: string, defs: ReactNode[], w: number, h: number): string | null {
  const k = SKETCH[style];
  if (!k) return null;
  const id = nid('sk');
  let n = 0;
  for (const ch of String(seed)) n = (n * 31 + ch.charCodeAt(0)) % 997;
  const pad = Math.ceil(k.scale * 2 + 4);
  defs.push(<filter key={id} id={id} filterUnits="userSpaceOnUse" x={f3(-pad)} y={f3(-pad)} width={f3(w + 2 * pad)} height={f3(h + 2 * pad)} colorInterpolationFilters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency={k.freq} numOctaves={k.octaves} seed={n + 1} result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale={k.scale} xChannelSelector="R" yChannelSelector="G"/>
  </filter>);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Text effects (Format > WordArt Styles > Text Effects): a run's glow and reflection and the text's bevel. PowerPoint's behaviour, not checked against upstream.

/** A run's glow: its letters dilated, blurred and flooded with the glow colour, drawn under them. `id` is the filter to put on the glow's copy of the text. */
export function textGlow(g: Any, x: number, y: number, w: number, h: number): {id: string; def: ReactNode} {
  const id = nid('tg'), c = g.color ?? {r: 91, g: 155, b: 213, a: 100}, r = Math.max(num(g.radius, 5), 0.5);
  const pad = Math.ceil(r * 2 + 4);
  return {id, def: <defs><filter id={id} filterUnits="userSpaceOnUse" x={f3(x - pad)} y={f3(y - pad)} width={f3(w + 2 * pad)} height={f3(h + 2 * pad)} colorInterpolationFilters="sRGB">
    <feMorphology in="SourceAlpha" operator="dilate" radius={f3(r / 3)} result="d"/>
    <feGaussianBlur in="d" stdDeviation={f3(r / 2)} result="b"/>
    <feFlood floodColor={rgb(c)} floodOpacity={f3(Math.max(alpha(c), 0.45))} result="c"/>
    <feComposite in="c" in2="b" operator="in" result="g"/>
    <feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter></defs>};
}

/** A run's reflection: the mask that fades the flipped copy of its text. `dist` is the gap below the line. */
export function textReflection(r: Any, x: number, y: number, w: number, h: number): {id: string; dist: number; def: ReactNode} {
  const id = nid('tr'), grad = nid('trg');
  const dist = num(r.dist), end = Math.min(Math.max(num(r.endPos, 0.35), 0.01), 1);
  const start = Math.min(Math.max(num(r.startAlpha, 0.5), 0), 1), stop = Math.min(Math.max(num(r.endAlpha), 0), 1);
  const top = y + h + dist, height = Math.max(end * h, 1);
  return {id, dist, def: <defs>
    <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="0" y1={f3(top)} x2="0" y2={f3(top + height)}><stop offset="0" stopColor="#fff" stopOpacity={f3(start)}/><stop offset="1" stopColor="#fff" stopOpacity={f3(stop)}/></linearGradient>
    <mask id={id} maskUnits="userSpaceOnUse" x={f3(x - 4)} y={f3(top)} width={f3(w + 8)} height={f3(height)}><rect x={f3(x - 4)} y={f3(top)} width={f3(w + 8)} height={f3(height)} fill={`url(#${grad})`}/></mask>
  </defs>};
}

/** The text's bevel (kept `a:sp3d` XML of the text body): lit from the upper left like a shape's. Null when there is none. */
export function textBevel(raw3d: unknown): {id: string; def: ReactNode} | null {
  if (typeof raw3d !== 'string') return null;
  const m = /<a:bevelT\b([^>]*)>/.exec(raw3d);
  if (!m) return null;
  const at = (n: string) => { const v = new RegExp(`\\b${n}="(\\d+)"`).exec(m[1]); return v ? Number(v[1]) / 12700 : 6; };
  const bh = Math.min(Math.max(at('h') * 0.5, 0.6), 4), id = nid('tb');
  return {id, def: <defs><filter id={id} x="-5%" y="-10%" width="110%" height="120%" colorInterpolationFilters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="0.7" result="b"/>
    <feDiffuseLighting in="b" surfaceScale={f3(bh)} diffuseConstant="1.15" lightingColor="#ffffff" result="d"><feDistantLight azimuth="225" elevation="52"/></feDiffuseLighting>
    <feComposite in="SourceGraphic" in2="d" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="lit"/>
    <feComposite in="lit" in2="SourceAlpha" operator="in"/>
  </filter></defs>};
}
