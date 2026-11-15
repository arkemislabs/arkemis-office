// A slide drawn as SVG (architecture 16.3): background, the master's and layout's graphics when the
// slide shows them, then the slide's shapes in z-order. Shapes are the translated deckcraft preset
// or custom geometry (core/prism/model/render.mjs shapePaint) with resolved fills, lines and
// arrowheads; text bodies are laid out by the translated text crate (core/prism/model/textlayout.mjs)
// on Canvas2D metrics and drawn line by line at the computed positions, so wrapping, autofit,
// bullets and alignment are deckcraft's. One SVG unit is one point.
// Follows deckcraft crates/render/src/renderer.rs (draw order, editor-only placeholder prompts and
// dashed outlines, picture crop), geometry.rs (fill modes), text_draw.rs (text_transform,
// prompt_body) at f893f6af7d36a5409fd804e81a34fd895cfefedf. F:prism surface.

import {memo, type ReactNode} from 'react';
import {imageDimensions, base64Decode} from '../../../../core/prism/lib/shape-common.mjs';
import {runs as patternRuns} from '../../../../core/prism/lib/pattern.mjs';
import {ctxForSlide, ctxForLayout, ctxForMaster, background as resolveBackground, showMasterShapes, xfrm as ctxXfrm} from '../../../../core/prism/model/resolve.mjs';
import {shapePaint, cropDest, trimEnds, paintOf} from '../../../../core/prism/model/render.mjs';
import {layoutText} from '../../../../core/prism/model/textlayout.mjs';
import {css as cssColor, lerp, WHITE, BLACK} from '../../../../core/prism/model/color.mjs';
import {masterFor, phPrompt, isFooterPh, mediaById, isLine} from '../../../../core/prism/model/presentation.mjs';
import {bodyEmpty} from '../../../../core/prism/model/text.mjs';
import {xfrmAffine, groupChildAffine} from '../../../../core/prism/model/geom/index.mjs';
import {svgPath, affChain, affTranslate, affRotate, affScaleXY, affDeterminant, rect as kRect} from '../../../../core/prism/model/geom/kurbo.mjs';
import {resolveStyle as resolveTableStyle, drawnHeights as tableDrawnHeights, setTextMeasure as setTableTextMeasure, cellRects as tableCellRects, lookOf as tableLook, cellBody as tableCellBody, cellShape as tableCellShape, styleFill as tableStyleFill} from '../../../../core/prism/model/table-style.mjs';
import {dashPattern} from '../../../../core/prism/model/style.mjs';
import {fontStack, measure, metrics} from './measure.mjs';
import {ChartGroup} from './ChartPrims';
import {chartPrims} from '../../../../core/prism/lib/chart.mjs';
import {ctxColor} from '../../../../core/prism/model/resolve.mjs';
import {effectLayers, adjustFilter, textGlow, textReflection, textBevel, sketchFilter} from './effects';
import {cameraOf, aboutCenter} from '../../../../core/prism/lib/camera3d.mjs';

type Any = any;
export const matrix = (m: number[]) => `matrix(${m.map(v => (Number.isFinite(v) ? +v.toFixed(6) : 0)).join(' ')})`;
const color = (c: Any) => (c ? cssColor(c) : 'none');
let gid = 0;
const nextId = (p: string) => `${p}${(++gid).toString(36)}`;

/** Layout options shared by the canvas, the thumbnails and the pointer (caret placement). */
export const LAYOUT_OPTS = {measure: (f: Any, t: string) => measure(f, t), metrics: (f: Any) => metrics(f)};
// Tables measure their rows with the same canvas metrics (their boxes and hit tests are the model's).
setTableTextMeasure(LAYOUT_OPTS);

/** What a show draws shapes with at one moment (core/prism/lib/anim-frame.mjs): a state per animated shape and paragraph. */
export interface AnimFrame {
  shape(id: string): Any | null;
  para(id: string, index: number): Any | null;
}
/** Which layers to draw: the whole slide, its background with the master's and layout's graphics alone, or its own shapes alone over transparency (the transitions that move contents over backgrounds). */
export type SlideParts = 'all' | 'back' | 'content';

export interface SlideViewProps {
  content: Any;
  slide: Any;
  /** Editor view: placeholder prompts and dashed placeholder outlines (never in thumbnails or the show). */
  editor?: boolean;
  className?: string;
  children?: ReactNode;
  /** The slide show's animation state of each shape (offset, scale, rotation, reveal clip, opacity, colour; hidden shapes are not drawn). */
  anim?: AnimFrame | null;
  parts?: SlideParts;
  /** A Morph frame's override of one shape (core/prism/lib/morph.mjs): its box, fill colour, picture crop, opacity, or not drawn. */
  fx?: ((id: string) => {xfrm?: Any; fill?: Any; crop?: number[]; opacity?: number; hide?: boolean} | null) | null;
  /** Opacity of the background with the master's and layout's graphics (a Morph fades the new slide's in over the old one's). */
  backOpacity?: number;
  /** Review > Hide Ink: the ink drawn on the slide is not drawn. */
  hideInk?: boolean;
}

/** The whole slide as one SVG in slide points (width × height of the deck's slide size). */
export const SlideView = memo(function SlideView({content, slide, editor = false, className, children, anim = null, parts = 'all', fx = null, backOpacity = 1, hideInk = false}: SlideViewProps) {
  const size = slide.size ?? content.slideSize;
  const ctx = ctxForSlide(content, slide);
  if (!ctx) return <svg className={className} viewBox={`0 0 ${size.width} ${size.height}`}/>;
  const ml = masterFor(content, slide);
  const [master, layout] = ml ?? [null, null];
  const [showLayout, showMaster] = showMasterShapes(slide, layout);
  const defs: ReactNode[] = [];
  const [bgFill, bgPh] = resolveBackground(ctx, slide);
  const bg = paintOf(ctx, bgFill, bgPh);
  // Shapes are drawn eagerly (plain calls, not components) so the gradients, patterns and clip
  // paths they add are in `defs` before the SVG element is built.
  const bgPaint = paintRef(bg, defs, {x0: 0, y0: 0, x1: size.width, y1: size.height}, content) ?? '#ffffff';
  const back = parts !== 'content', front = parts !== 'back';
  const masterLayer = back && master && showMaster
    ? (master.shapes ?? []).filter((s: Any) => !s.ph && !s.hidden).map((s: Any) => <g key={`m${s.id}`}>{ShapeNode({ctx: ctxForMaster(content, master), sh: s, defs, editor: false, content, background: bg})}</g>) : null;
  const layoutLayer = back && layout && showLayout
    ? (layout.shapes ?? []).filter((s: Any) => !s.ph && !s.hidden).map((s: Any) => <g key={`l${s.id}`}>{ShapeNode({ctx: ctxForLayout(content, master, layout), sh: s, defs, editor: false, content, background: bg})}</g>) : null;
  const slideLayer = !front ? null : (slide.shapes ?? []).filter((s: Any) => !s.hidden && !(hideInk && s.kind?.type === 'ink') && !(s.ph && isFooterPh(s.ph.kind)))
    .map((s0: Any) => {
      const st = anim?.shape(s0.id) ?? null;
      const o = fx?.(s0.id) ?? null;
      if (o?.hide || (o && o.opacity !== undefined && o.opacity <= 0) || (st && (!st.visible || st.opacity <= 0))) return null;
      const s = o?.crop && s0.kind?.type === 'picture' ? {...s0, kind: {...s0.kind, fill: {...s0.kind.fill, crop: o.crop}}} : s0;
      const box = o?.xfrm ?? resolvedXfrm(ctx, s);
      const node = ShapeNode({ctx, sh: s, defs, editor, content, background: bg, xfrm: o?.xfrm, tint: o?.fill ?? st?.tint ?? null, paras: anim ? (i: number) => anim.para(s.id, i) : undefined});
      const drawn = st ? animated(node, st, box, defs) : node;
      return <g key={s.id} opacity={o?.opacity !== undefined && o.opacity < 1 ? o.opacity : undefined}>{drawn}</g>;
    });
  return <svg className={className} viewBox={`0 0 ${size.width} ${size.height}`} xmlns="http://www.w3.org/2000/svg" overflow="hidden">
    <defs>{defs}</defs>
    {back ? <rect x={0} y={0} width={size.width} height={size.height} fill={bgPaint} opacity={backOpacity < 1 ? backOpacity : undefined}/> : null}
    {masterLayer ? <g data-layer="master" opacity={backOpacity < 1 ? backOpacity : undefined}>{masterLayer}</g> : null}
    {layoutLayer ? <g data-layer="layout" opacity={backOpacity < 1 ? backOpacity : undefined}>{layoutLayer}</g> : null}
    {front ? <g data-layer="slide">{slideLayer}</g> : null}
    {children}
  </svg>;
});

/**
 * A shape drawn in its animation state (deckcraft show.rs ShapeState): translated by the offset, scaled and rotated about the centre
 * of its box, faded, revealed through a clip in its own unit space.
 */
function animated(node: ReactNode, st: Any, x: Any, defs: ReactNode[]): ReactNode {
  let inner = node;
  if (st.clip && (st.clip[0] > 0 || st.clip[1] > 0 || st.clip[2] < 1 || st.clip[3] < 1)) {
    const id = nextId('a');
    const [l, tp, r, b] = st.clip as number[];
    defs.push(<clipPath key={id} id={id}><rect x={x.x + l * x.w} y={x.y + tp * x.h} width={Math.max((r - l) * x.w, 0)} height={Math.max((b - tp) * x.h, 0)}
      transform={x.rot ? `rotate(${x.rot} ${x.x + x.w / 2} ${x.y + x.h / 2})` : undefined}/></clipPath>);
    inner = <g clipPath={`url(#${id})`}>{inner}</g>;
  }
  const cx = x.x + x.w / 2, cy = x.y + x.h / 2;
  const moved = st.offsetX !== 0 || st.offsetY !== 0, turned = st.scaleX !== 1 || st.scaleY !== 1 || st.rotate !== 0;
  const tf = [moved ? `translate(${+st.offsetX.toFixed(3)} ${+st.offsetY.toFixed(3)})` : '',
    turned ? `translate(${cx} ${cy}) rotate(${+st.rotate.toFixed(3)}) scale(${+st.scaleX.toFixed(4)} ${+st.scaleY.toFixed(4)}) translate(${-cx} ${-cy})` : ''].filter(Boolean).join(' ');
  return <g transform={tf || undefined} opacity={st.opacity < 1 ? st.opacity : undefined}>{inner}</g>;
}

/** An SVG paint for a resolved fill paint (gradients get a def). */
function paintRef(p: Any, defs: ReactNode[], box: Any, content: Any): string | null {
  if (!p || p.kind === 'none') return 'none';
  if (p.kind === 'solid') return color(p.color);
  if (p.kind === 'gradient') {
    const id = nextId('g');
    const stops = (p.stops ?? []).map((s: Any, i: number) => <stop key={i} offset={Math.min(Math.max(s.pos, 0), 1)} stopColor={cssColor({...s.color, a: 255})} stopOpacity={(s.color?.a ?? 255) / 255}/>);
    if (p.linear) {
      const a = ((p.linear.angle ?? 0) * Math.PI) / 180;
      const cx = 0.5, cy = 0.5, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
      defs.push(<linearGradient key={id} id={id} x1={cx - dx} y1={cy - dy} x2={cx + dx} y2={cy + dy}>{stops}</linearGradient>);
    } else {
      defs.push(<radialGradient key={id} id={id} cx={0.5} cy={0.5} r={0.71}>{stops}</radialGradient>);
    }
    return `url(#${id})`;
  }
  if (p.kind === 'pattern') {
    const id = nextId('p');
    defs.push(<pattern key={id} id={id} width={6} height={6} patternUnits="userSpaceOnUse"><rect width={6} height={6} fill={color(p.bg)}/>{patternRuns(p.preset).map(([x, y, n]: number[], i: number) => <rect key={i} x={x * 0.75} y={y * 0.75} width={n * 0.75} height={0.75} fill={color(p.fg)}/>)}</pattern>);
    return `url(#${id})`;
  }
  if (p.kind === 'picture') {
    const md = mediaById(content, p.media);
    if (!md?.data) return 'none';
    const id = nextId('i');
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    const href = `data:${md.contentType};base64,${md.data}`;
    const opacity = typeof p.alpha === 'number' && p.alpha < 1 ? p.alpha : undefined;
    const tile = p.mode?.kind === 'tile' ? p.mode : null;
    const dim = tile ? pictureSize(md) : null;
    if (tile && dim) {
      // A tiled picture (Format Background, Picture or texture fill, Tile picture as texture): the picture at its own size (96 dpi) times the scale, repeated from the aligned corner; Mirror flips alternate tiles.
      const tw = dim[0] * 0.75 * (tile.sx ?? 1), th = dim[1] * 0.75 * (tile.sy ?? 1);
      const ax = /r$/.test(tile.align ?? 'tl') ? 1 : tile.align === 'ctr' || tile.align === 't' || tile.align === 'b' ? 0.5 : 0;
      const ay = /^b/.test(tile.align ?? 'tl') ? 1 : tile.align === 'ctr' || tile.align === 'l' || tile.align === 'r' ? 0.5 : 0;
      const fx = tile.flip === 'x' || tile.flip === 'xy', fy = tile.flip === 'y' || tile.flip === 'xy';
      const cols = fx ? 2 : 1, rows = fy ? 2 : 1;
      const cell = (cx: number, cy: number) => <image key={`${cx}${cy}`} href={href} width={tw} height={th} preserveAspectRatio="none" opacity={opacity}
        transform={`translate(${(cx + (cx && fx ? 1 : 0)) * tw} ${(cy + (cy && fy ? 1 : 0)) * th}) scale(${cx && fx ? -1 : 1} ${cy && fy ? -1 : 1})`}/>;
      const cells = [];
      for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) cells.push(cell(cx, cy));
      defs.push(<pattern key={id} id={id} patternUnits="userSpaceOnUse" x={box.x0 + ax * (w - tw) + (tile.tx ?? 0)} y={box.y0 + ay * (h - th) + (tile.ty ?? 0)} width={tw * cols} height={th * rows}>{cells}</pattern>);
      return `url(#${id})`;
    }
    defs.push(<pattern key={id} id={id} patternUnits="userSpaceOnUse" x={box.x0} y={box.y0} width={w} height={h}>
      <image href={href} x={0} y={0} width={w} height={h} preserveAspectRatio="none" opacity={opacity}/></pattern>);
    return `url(#${id})`;
  }
  return 'none';
}

const sizes = new Map<string, [number, number] | null>();
/** A picture's own size in pixels (read from the file's header once), or null when it can't be read. */
function pictureSize(md: Any): [number, number] | null {
  const key = `${md.id}:${String(md.data).length}`;
  if (sizes.has(key)) return sizes.get(key) ?? null;
  let out: [number, number] | null = null;
  try { const d = imageDimensions(base64Decode(String(md.data))); if (d && d.w > 0 && d.h > 0) out = [d.w, d.h]; } catch { out = null; }
  sizes.set(key, out);
  return out;
}

/** deckcraft geometry.rs: shaded sub-paths of a preset (lighten/darken the fill colour). */
function shadeFill(paint: Any, mode: string, defs: ReactNode[], box: Any, content: Any): string | null {
  if (mode === 'none') return 'none';
  if (mode === 'norm' || paint?.kind !== 'solid') return paintRef(paint, defs, box, content);
  const c = paint.color;
  const towards = (t: Any, k: number) => cssColor(lerp(c, {...t, a: c.a}, k));
  if (mode === 'lighten') return towards(WHITE, 0.4);
  if (mode === 'lightenLess') return towards(WHITE, 0.2);
  if (mode === 'darken') return towards(BLACK, 0.4);
  if (mode === 'darkenLess') return towards(BLACK, 0.2);
  return paintRef(paint, defs, box, content);
}

const chartCache = new WeakMap<object, {w: number; h: number; scheme: unknown; out: Any}>();
/** A chart shape's drawing (cached per chart object and size: the model is immutable between edits). */
function chartOf(ctx: Any, sh: Any, w: number, h: number): Any {
  const hit = chartCache.get(sh.kind);
  if (hit && hit.w === w && hit.h === h && hit.scheme === ctx.master?.theme?.colors) return hit.out;
  const out = chartPrims(sh.kind, w, h, (ref: Any) => ctxColor(ctx, ref));
  chartCache.set(sh.kind, {w, h, scheme: ctx.master?.theme?.colors, out});
  return out;
}

interface NodeProps { ctx: Any; sh: Any; defs: ReactNode[]; editor: boolean; content: Any; background: Any; xfrm?: Any; tint?: Any; paras?: (index: number) => Any }

/** One shape (groups recurse through their child space). */
function ShapeNode({ctx, sh, defs, editor, content, background, xfrm, tint, paras}: NodeProps) {
  const x = xfrm ?? (sh.xfrm ?? resolvedXfrm(ctx, sh));
  const m = xfrmAffine(x);
  const k = sh.kind?.type;
  if (k === 'group') {
    const c = sh.kind.child ?? {x: 0, y: 0, w: x.w, h: x.h};
    const gm = groupChildAffine(x, {x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h});
    return <g transform={matrix(gm)} data-shape={sh.id}>
      {(sh.kind.children ?? []).filter((s: Any) => !s.hidden).map((s: Any) => <g key={s.id}>{ShapeNode({ctx, sh: s, defs, editor, content, background, xfrm: s.xfrm ?? {x: 0, y: 0, w: 0, h: 0}})}</g>)}
    </g>;
  }
  if (k === 'ink') {
    return <g transform={matrix(m)} data-shape={sh.id}>{(sh.kind.strokes ?? []).map((s: Any, i: number) => <polyline key={i} fill="none"
      points={(s.points ?? []).map((q: number[]) => `${q[0]},${q[1]}`).join(' ')} stroke={cssColor(s.color ?? BLACK)} strokeOpacity={s.highlighter ? 0.45 : 1}
      strokeWidth={s.width ?? 1} strokeLinecap="round" strokeLinejoin="round"/>)}</g>;
  }
  const w = Math.max(x.w, 0), h = Math.max(x.h, 0);
  const paint = shapePaint(ctx, sh, w, h, {background});
  // A colour emphasis (Fill Color, Darken, Color Pulse…) draws the shape's fill in the effect's colour.
  if (tint && paint.fill && paint.fill.kind !== 'none') paint.fill = {kind: 'solid', color: tint};
  const box = {x0: 0, y0: 0, x1: w, y1: h};
  const isPic = k === 'picture';
  const emptyPh = !!sh.ph && (!sh.text || bodyEmpty(sh.text)) && !isPic && k !== 'media';
  const parts: ReactNode[] = [];
  const line = paint.line;
  const stroke = line.paint.kind === 'none' ? 'none' : line.paint.kind === 'solid' ? color(line.paint.color) : paintRef(line.paint, defs, box, content) ?? 'none';
  const strokeProps = {stroke, strokeWidth: line.width, strokeDasharray: line.dash?.length ? line.dash.join(' ') : undefined,
    strokeLinecap: line.cap === 'flat' ? 'butt' : line.cap, strokeLinejoin: line.join, vectorEffect: undefined} as Any;
  if (isPic) {
    const md = mediaById(content, sh.kind.fill?.media);
    const clip = nextId('c');
    defs.push(<clipPath key={clip} id={clip}><path d={paint.geo.paths.map((p: Any) => svgPath(p.path)).join(' ')}/></clipPath>);
    const d = cropDest(kRect(0, 0, w, h), sh.kind.fill?.crop);
    const adj = adjustFilter(ctx, sh.kind.fill?.adjust, defs);
    if (md?.data) parts.push(<image key="img" clipPath={`url(#${clip})`} href={`data:${md.contentType};base64,${md.data}`} x={d.x0} y={d.y0} width={d.x1 - d.x0} height={d.y1 - d.y0} preserveAspectRatio="none" filter={adj ? `url(#${adj})` : undefined}/>);
    else if (editor) parts.push(<rect key="img" width={w} height={h} fill="#f2f2f2"/>);
  }
  if (k === 'media') {
    // An audio or video clip: its poster frame, else a dark frame with a play mark (video) or a speaker (audio).
    const mk = sh.kind, poster = mk.poster ? mediaById(content, mk.poster) : null;
    if (mk.video) {
      if (poster?.data) parts.push(<image key="poster" href={`data:${poster.contentType};base64,${poster.data}`} x={0} y={0} width={w} height={h} preserveAspectRatio="xMidYMid slice"/>);
      else parts.push(<rect key="vf" width={w} height={h} fill="#17171a"/>);
      if (editor) parts.push(<g key="pm" opacity={0.85}><circle cx={w / 2} cy={h / 2} r={Math.max(Math.min(w, h) * 0.14, 6)} fill="#fff" fillOpacity={0.9}/><path d={`M${w / 2 - Math.min(w, h) * 0.04} ${h / 2 - Math.min(w, h) * 0.07}L${w / 2 + Math.min(w, h) * 0.08} ${h / 2}L${w / 2 - Math.min(w, h) * 0.04} ${h / 2 + Math.min(w, h) * 0.07}Z`} fill="#222"/></g>);
    } else if (editor || !mk.hideWhileNotPlaying) {
      const u = Math.min(w, h);
      parts.push(<g key="au" transform={`translate(${(w - u) / 2} ${(h - u) / 2}) scale(${u / 24})`}><rect width={24} height={24} rx={5} fill="#e6e6ea" stroke="#9a9aa2" strokeWidth={0.6}/>
        <path d="M6 10h3l4-3.5v11L9 14H6z" fill="#3a3a42"/><path d="M15.5 9.5a3.4 3.4 0 0 1 0 5M17.4 7.6a6 6 0 0 1 0 8.8" fill="none" stroke="#3a3a42" strokeWidth={1.2} strokeLinecap="round"/></g>);
    }
  }
  if (!emptyPh && !isPic && k !== 'media') {
    paint.geo.paths.forEach((sp: Any, i: number) => {
      const d = sp.path && sp.path.length ? svgPath(paint.line.heads?.length && i === paint.geo.paths.findIndex((p: Any) => p.stroke) ? trimEnds(sp.path, line.trims?.[0] ?? 0, line.trims?.[1] ?? 0) : sp.path) : '';
      if (!d) return;
      const f = shadeFill(paint.fill, sp.fill ?? 'norm', defs, box, content) ?? 'none';
      const fillOpacity = paint.fill?.kind === 'solid' ? (paint.fill.color?.a ?? 255) / 255 : undefined;
      // A sketched outline: the fill as it is, and the stroke apart, run through the wobble.
      const sketch = sp.stroke && stroke !== 'none' && line.sketch ? sketchFilter(line.sketch, sh.id, defs, w, h) : null;
      if (sketch) {
        parts.push(<path key={`p${i}`} d={d} fill={f} fillRule={sp.evenOdd ? 'evenodd' : 'nonzero'} fillOpacity={fillOpacity} stroke="none"/>);
        parts.push(<path key={`s${i}`} d={d} fill="none" filter={`url(#${sketch})`} {...strokeProps}/>);
        return;
      }
      parts.push(<path key={`p${i}`} d={d} fill={f} fillRule={sp.evenOdd ? 'evenodd' : 'nonzero'} fillOpacity={fillOpacity}
        {...(sp.stroke ? strokeProps : {stroke: 'none'})}/>);
    });
    (line.heads ?? []).forEach((hd: Any, i: number) => parts.push(<path key={`h${i}`} d={svgPath(hd.path)} fill={hd.filled ? stroke : 'none'} stroke={stroke}
      strokeWidth={hd.strokeWidth ?? line.width} strokeLinejoin="miter"/>));
  } else if (isPic && line.paint.kind !== 'none') {
    parts.push(<path key="o" d={paint.geo.paths.map((p: Any) => svgPath(p.path)).join(' ')} fill="none" {...strokeProps}/>);
  }
  if (k === 'table') parts.push(<g key="t">{TableNode({ctx, sh, defs, content})}</g>);
  if (k === 'chart') parts.push(<ChartGroup key="chart" chart={chartOf(ctx, sh, w, h)}/>);
  if (editor && emptyPh) parts.push(<rect key="ph" x={0} y={0} width={w} height={h} fill="none" stroke="#9a9a9a" strokeWidth={0.75} strokeDasharray="3 2" vectorEffect="non-scaling-stroke"/>);
  if (k === 'shape' || k === 'connector') {
    const body = sh.text && !bodyEmpty(sh.text) ? sh.text : editor && emptyPh ? promptBody(sh) : null;
    if (body) parts.push(<g key="txt">{TextNode({ctx, sh, body, rect: paint.geo.textRect, m, prompt: body !== sh.text, paras})}</g>);
  }
  // Effects: the shape's art sits in its own group (the shadow, glow and reflection are copies of it).
  // 3-D Rotation and extrusion (a camera preset or the shape's own angles, a depth): the shape is drawn through the camera's map and, with a depth, its
  // back is drawn that far behind it in a darker shade (core/prism/lib/camera3d.mjs).
  const cam = cameraOf(paint.effects?.raw3d);
  const camM = cam ? aboutCenter(cam, w / 2, h / 2) : null;
  const m3 = camM ? affChain(m, camM) : m;
  const coreId = nextId('e');
  const layers = effectLayers(ctx, sh, m3, w, h, defs, coreId);
  let body: ReactNode = parts;
  if (layers) {
    const core = layers.filters.reduceRight((inner: ReactNode, f: string) => <g filter={`url(#${f})`}>{inner}</g>, parts as ReactNode);
    body = <>{layers.before}<g id={coreId}>{core}</g>{layers.after}</>;
  }
  if (!cam || !camM) {
    if (!layers) return <g transform={matrix(m)} data-shape={sh.id} data-line={isLine(sh) ? 'true' : undefined}>{parts}</g>;
    return <g transform={matrix(m)} data-shape={sh.id} data-line={isLine(sh) ? 'true' : undefined}>{body}</g>;
  }
  let back: ReactNode = null;
  const reach = Math.hypot(cam.ex, cam.ey) * cam.depth;
  if (reach >= 0.75) {
    const art = (parts as Any[]).filter(q => q?.key !== 'txt');
    const artId = nextId('x'), fid = nextId('xf'), n = Math.min(Math.ceil(reach / 0.6), 120);
    defs.push(<g key={artId} id={artId}>{art}</g>);
    defs.push(<filter key={fid} id={fid} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values="0.58 0 0 0 0 0 0.58 0 0 0 0 0 0.58 0 0 0 0 0 1 0"/></filter>);
    back = <g filter={`url(#${fid})`} data-extrusion="true">{Array.from({length: n}, (_, k) => {
      const f = (n - k) / n;
      return <use key={k} href={`#${artId}`} transform={`translate(${+(cam.ex * cam.depth * f).toFixed(3)} ${+(cam.ey * cam.depth * f).toFixed(3)}) ${matrix(camM)}`}/>;
    })}</g>;
  }
  return <g transform={matrix(m)} data-shape={sh.id} data-line={isLine(sh) ? 'true' : undefined} data-camera={cam.s3.camera}>
    {back}<g transform={matrix(camM)}>{body}</g>
  </g>;
}

function resolvedXfrm(ctx: Any, sh: Any) {
  // Placeholders without their own box take the layout's or master's (deckcraft xfrm_of).
  return ctxXfrm(ctx, sh);
}

/** deckcraft text_draw `prompt_body`: the prompt an empty placeholder shows in the editor. */
function promptBody(sh: Any) {
  const kind = sh.ph?.kind;
  const txt = phPrompt(kind);
  if (!txt || isFooterPh(kind)) return null;
  const para: Any = {level: 0, runs: [{text: txt}]};
  const body: Any = {body: {}, paragraphs: [para]};
  if (['picture', 'chart', 'table', 'media', 'diagram', 'clipArt'].includes(kind)) {
    body.body = {anchor: 'bottom'};
    para.props = {align: 'center', bullet: {kind: 'none'}, marginLeft: 0, indent: 0};
    para.runs = [{text: txt, props: {size: 14}}];
  }
  return body;
}

/** A laid-out text body in shape-local points (deckcraft `text_transform` unmirrors flips and turns vertical text). */
function TextNode({ctx, sh, body, rect, m, prompt, paras}: {ctx: Any; sh: Any; body: Any; rect: Any; m: number[]; prompt: boolean; paras?: (index: number) => Any}) {
  const l = layoutText(ctx, sh, body, {rect, ...LAYOUT_OPTS});
  const c = {x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2};
  let t = [1, 0, 0, 1, 0, 0];
  if (affDeterminant(m) < 0) t = affChain(t, affTranslate(c), affScaleXY(-1, 1), affTranslate({x: -c.x, y: -c.y}));
  if (l.rotation) t = affChain(t, affTranslate(c), affRotate((l.rotation * Math.PI) / 180), affTranslate({x: -c.x, y: -c.y}));
  // The text's own 3-D (Text Effects › 3-D Rotation, Bevel): turned about the middle of the text box, the bevel lit from the upper left.
  const t3 = cameraOf(body?.body?.raw3d);
  if (t3) t = affChain(t, aboutCenter(t3, c.x, c.y));
  const bevelId = textBevel(body?.body?.raw3d);
  return <g transform={matrix(t)} className="prism-text" data-prompt={prompt ? 'true' : undefined} filter={bevelId ? `url(#${bevelId.id})` : undefined}>
    {bevelId ? bevelId.def : null}
    {l.lines.map((ln: Any, i: number) => {
      // A by-paragraph build: a paragraph not yet entered is not drawn; one entering fades and moves on its own.
      const ps = paras ? paras(ln.para) : null;
      if (ps && (!ps.visible || ps.opacity <= 0)) return null;
      return <g key={i} opacity={ps && ps.opacity < 1 ? ps.opacity : undefined} transform={ps && (ps.offsetX || ps.offsetY) ? `translate(${ps.offsetX} ${ps.offsetY})` : undefined}>
      {ln.bullet ? <text x={ln.bullet.x} y={ln.bullet.baseline} style={runStyle(ln.bullet.style, prompt)} xmlSpace="preserve">{ln.bullet.text}</text> : null}
      {ln.segments.map((sg: Any, j: number) => sg.text ? <Seg key={j} sg={sg} baseline={ln.baseline} top={ln.top} bottom={ln.bottom} prompt={prompt}/> : null)}
    </g>; })}
  </g>;
}

function runStyle(st: Any, prompt: boolean): Any {
  return {fontFamily: fontStack(st.family), fontSize: st.size * (st.baseline ? 2 / 3 : 1), fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? 'italic' : 'normal',
    fill: prompt ? '#7a7a7a' : cssColor(st.color), whiteSpace: 'pre', letterSpacing: st.spacing ? `${st.spacing}px` : undefined};
}

function Seg({sg, baseline, top, bottom, prompt}: {sg: Any; baseline: number; top: number; bottom: number; prompt: boolean}) {
  const st = sg.style;
  const shift = st.baseline ? -(st.baseline / 100) * st.size : 0;
  const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined;
  const text = (props: Any = {}) => <text x={sg.x} y={baseline + shift} textLength={sg.width > 0 && sg.text.length > 1 ? sg.width : undefined} lengthAdjust="spacing"
    style={{...runStyle(st, prompt), textDecoration: deco}} xmlSpace="preserve" {...props}>{sg.text}</text>;
  const glow = st.glow ? textGlow(st.glow, sg.x, top, sg.width, bottom - top) : null;
  const refl = st.reflection ? textReflection(st.reflection, sg.x, top, sg.width, bottom - top) : null;
  return <>
    {st.highlight ? <rect x={sg.x} y={top} width={sg.width} height={bottom - top} fill={cssColor(st.highlight)}/> : null}
    {glow?.def}{refl?.def}
    {glow ? text({filter: `url(#${glow.id})`}) : null}
    {refl ? <g mask={`url(#${refl.id})`}><g transform={`translate(0 ${+(2 * bottom + refl.dist).toFixed(3)}) scale(1 -1)`}>{text()}</g></g> : null}
    {text()}
  </>;
}

/**
 * A table drawn as deckcraft's render/table.rs does: the style's background and the table's own, each cell's fill (its own, else the
 * table style's), the diagonal borders, then each cell's four borders (its own, else the style's lines), then the text with the
 * style's text colour and bold. Rows grow to fit their text; columns and rows are as stored (the box does not scale them).
 */
function TableNode({ctx, sh, defs, content}: {ctx: Any; sh: Any; defs: ReactNode[]; content: Any}) {
  const t = sh.kind;
  const def = resolveTableStyle(ctx, t);
  const heights = tableDrawnHeights(ctx, sh);
  const rects = tableCellRects(t, heights);
  const out: ReactNode[] = [];
  if (!rects.length) return <g data-table="true"/>;
  const all = {x0: Math.min(...rects.map(r => r.x0)), y0: Math.min(...rects.map(r => r.y0)), x1: Math.max(...rects.map(r => r.x1)), y1: Math.max(...rects.map(r => r.y1))};
  const fillOf = (f: Any, ph: Any, box: Any) => paintRef(paintOf(ctx, f, ph), defs, box, content) ?? 'none';
  const styleBg = def?.background ? tableStyleFill(ctx, def.background) : null;
  for (const [i, bg] of [styleBg, t.background ? [t.background, null] : null].entries()) {
    if (bg) out.push(<rect key={`bg${i}`} x={all.x0} y={all.y0} width={all.x1 - all.x0} height={all.y1 - all.y0} fill={fillOf(bg[0], bg[1], all)}/>);
  }
  const looks = new Map<string, Any>();
  const look = (r: number, c: number) => { const k = r + ',' + c; let v = looks.get(k); if (!v) { v = tableLook(ctx, t, r, c, def); looks.set(k, v); } return v; };
  for (const rc of rects) {
    const cell = t.rows[rc.r].cells[rc.c];
    const lk = look(rc.r, rc.c);
    const box = {x0: rc.x0, y0: rc.y0, x1: rc.x1, y1: rc.y1};
    let fill: string | null = null;
    if (cell.fill) fill = fillOf(cell.fill, null, box);
    else if (lk.paint) fill = fillOf(lk.paint[0], lk.paint[1], box);
    else if (lk.fill && lk.fill.a > 0) fill = cssColor(lk.fill);
    if (fill && fill !== 'none') out.push(<rect key={`f${rc.r}-${rc.c}`} x={rc.x0} y={rc.y0} width={rc.x1 - rc.x0} height={rc.y1 - rc.y0} fill={fill}/>);
  }
  const lineProps = (l: Any, minW: number) => {
    const f = l.fill && l.fill.kind !== 'none' ? paintOf(ctx, l.fill, null) : null;
    if (!f) return null;
    const w = Math.max(l.width ?? 1, minW);
    const dash = dashPattern(l.dash).map((v: number) => v * w);
    return {stroke: paintRef(f, defs, all, content) ?? 'none', strokeWidth: w, strokeDasharray: dash.length ? dash.join(' ') : undefined, strokeLinecap: l.cap === 'flat' || !l.cap ? 'butt' : l.cap} as Any;
  };
  // Diagonal borders, under the edges.
  for (const rc of rects) {
    const cell = t.rows[rc.r].cells[rc.c];
    for (const [k, l, a, b] of [['d', cell.diagDown, [rc.x0, rc.y0], [rc.x1, rc.y1]], ['u', cell.diagUp, [rc.x0, rc.y1], [rc.x1, rc.y0]]] as Any[]) {
      const pr = l ? lineProps(l, 0) : null;
      if (pr) out.push(<line key={`g${k}${rc.r}-${rc.c}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...pr}/>);
    }
  }
  // Borders: explicit cell borders, else the style's grid.
  for (const rc of rects) {
    const cell = t.rows[rc.r].cells[rc.c];
    const lk = look(rc.r, rc.c);
    const edges = [[rc.x0, rc.y0, rc.x0, rc.y1], [rc.x1, rc.y0, rc.x1, rc.y1], [rc.x0, rc.y0, rc.x1, rc.y0], [rc.x0, rc.y1, rc.x1, rc.y1]];
    edges.forEach((e, i) => {
      const own = cell.borders?.[i];
      let pr: Any = null;
      if (own) pr = lineProps(own, 0.25);
      else {
        const b = lk.sides[i] ?? lk.border;
        if (b && b[0].a > 0 && b[1] > 0) pr = {stroke: cssColor(b[0]), strokeWidth: Math.max(b[1], 0.25)};
      }
      if (pr) out.push(<line key={`b${rc.r}-${rc.c}-${i}`} x1={e[0]} y1={e[1]} x2={e[2]} y2={e[3]} {...pr}/>);
    });
  }
  for (const rc of rects) {
    const cell = t.rows[rc.r].cells[rc.c];
    if (!cell.text || !(cell.text.paragraphs ?? []).length || bodyEmpty(cell.text)) continue;
    const body = tableCellBody(ctx, t, rc.r, rc.c, cell, def);
    out.push(<g key={`t${rc.r}-${rc.c}`}>{TextNode({ctx, sh: tableCellShape(sh, body), body, rect: {x0: rc.x0, y0: rc.y0, x1: rc.x1, y1: rc.y1}, m: [1, 0, 0, 1, 0, 0], prompt: false})}</g>);
  }
  return <g data-table="true">{out}</g>;
}
