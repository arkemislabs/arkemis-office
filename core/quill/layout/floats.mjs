// Floating objects: where they go, the areas text wraps around, and the items that draw pictures,
// shapes and text boxes (inline and floating).
//
// Translated from wordcraft crates/layout/src/floats.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: Tight/Through contours
// (`contour.rs`: those wraps use the object's rectangle, as Square does), floats found above their
// anchors relaid in a second pass (`EarlyFloats`, #2048), groups' member items (a group draws as
// its frame), SmartArt is drawn as primitives too (lib/smartart-word.mjs). A chart is drawn by Grid's chart renderer
// (core/quill/lib/chart-draw.mjs) into one 'chart' item of drawing primitives.
import {textBodyInsetsPt} from '../model/content.mjs';
import {fillForm, fillMainColor} from '../model/fill.mjs';
import {groupRects} from '../model/para.mjs';
import {shapeOutline, wrapPolygonUnit} from '../model/wrap.mjs';
import {chartPrims, gridTheme} from '../lib/chart-draw.mjs';
import {cachedPrims as smartArtPrims} from '../lib/smartart-word.mjs';
import {MATH_FONT} from '../lib/math-layout.mjs';
import {CL} from './para/model.mjs';
import {leftOut} from './para/builder.mjs';
import {rect} from './placed.mjs';

/** A floating drawing's [w, h, float], or null (floating). */
export function floating(o) {
  if (!o || !['image', 'graphic', 'shape', 'group'].includes(o.type)) return null;
  const f = o.float ?? {wrap: 'inline'};
  return (f.wrap ?? 'inline') === 'inline' ? null : [o.w, o.h, f];
}
/** Is `o` a floating object (is_floating)? */
export const isFloating = o => floating(o) !== null;

const fin = v => (Number.isFinite(v) ? v : 0);

/** The page frame's left and right margins and the even-page mirroring shift (PageFrame::sides). */
function sides(frame) {
  const s = frame.sect;
  const inside = s.marginLeft + s.gutter, outside = s.marginRight;
  const shift = outside - inside;
  return frame.mirror && frame.number % 2 === 0 && Number.isFinite(shift) ? [outside, inside, shift] : [inside, outside, 0];
}

/** Alignment `a` within (start, extent) (align_in). */
export function alignIn([start, extent], offset, size, align) {
  switch (align) {
    case 'start': case 'inside': return start;
    case 'center': return start + (extent - size) / 2;
    case 'end': case 'outside': return start + extent - size;
    default: return start + (Number.isFinite(offset) ? Math.max(-31680, Math.min(31680, offset)) : 0);
  }
}

/** Where a floating object of w × h goes (float_rect); `frame`: {sect, origin: [x, y], number, mirror} or null. */
export function floatRect(frame, col, y0, w, h, f) {
  w = Math.max(0, Math.min(4000, fin(w)));
  h = Math.max(0, Math.min(4000, fin(h)));
  const pageX = fr => {
    const s = fr.sect, even = fr.number % 2 === 0;
    const [left, right, shift] = sides(fr);
    let r;
    switch (f.hRel) {
      case 'page': r = [0, s.pageW]; break;
      case 'margin': r = [left, textWidthOf(s)]; break;
      case 'leftMargin': r = [0, left]; break;
      case 'rightMargin': r = [s.pageW - right, right]; break;
      case 'insideMargin': r = even ? [s.pageW - right, right] : [0, left]; break;
      case 'outsideMargin': r = !even ? [s.pageW - right, right] : [0, left]; break;
      default: return null;
    }
    return [r[0] - shift, r[1]];
  };
  const pageY = s => {
    switch (f.vRel) {
      case 'page': return [0, s.pageH];
      case 'margin': return [s.marginTop, s.pageH - s.marginTop - s.marginBottom];
      case 'topMargin': case 'insideMargin': return [0, s.marginTop];
      case 'bottomMargin': case 'outsideMargin': return [s.pageH - s.marginBottom, s.marginBottom];
      default: return null;
    }
  };
  let hx = col, vy = [y0, 0];
  if (frame) {
    const px = pageX(frame);
    if (px) hx = [px[0] - frame.origin[0], px[1]];
    const py = pageY(frame.sect);
    if (py) vy = [py[0] - frame.origin[1], py[1]];
  }
  let ha = f.hAlign ?? null;
  if (frame && frame.number % 2 === 0) { if (ha === 'inside') ha = 'end'; else if (ha === 'outside') ha = 'start'; }
  const va = frame ? f.vAlign ?? null : null;
  return rect(alignIn(hx, f.x, w, ha), alignIn(vy, f.y, h, va), w, h);
}
export const textWidthOf = s => Math.max(s.pageW - s.marginLeft - s.marginRight - s.gutter, 18);

/** The rotated bounds of `r` turned `rot` degrees about its centre (Spin::bounds). */
export function spinBounds(r, rot) {
  if (!rot) return r;
  const t = rot * Math.PI / 180;
  const w = Math.abs(r.w * Math.cos(t)) + Math.abs(r.h * Math.sin(t)), h = Math.abs(r.w * Math.sin(t)) + Math.abs(r.h * Math.cos(t));
  return rect(r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}

/** The area text keeps clear of around a floating object (wrap_area): {rect, topBottom, side, table} or null. */
export function wrapArea(r, f) {
  const wrap = f.wrap ?? 'inline';
  if (wrap === 'inline' || wrap === 'behindText' || wrap === 'inFrontOfText') return null;
  const d = v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0);
  const side = d(f.dist), top = d(f.distTop), bottom = d(f.distBottom);
  const b = spinBounds(r, f.rot ?? 0);
  return {rect: rect(b.x - side, b.y - top, b.w + side * 2, b.h + top + bottom), topBottom: wrap === 'topAndBottom', side: f.wrapText ?? 'bothSides', table: false};
}

/** The outline text follows round a Tight or Through object, in unit coordinates: its wrap polygon, else a shape's own outline; null for a plain rectangle. */
function contourOf(o, f) {
  if (f.wrapPolygon?.points?.length >= 3) return wrapPolygonUnit(f.wrapPolygon);
  if (o?.type === 'shape' && o.kind === 'freeform' && o.freeform && !o.freeform.ink) {
    // An outline drawn or edited by hand (Edit Points): its first closed path, in unit coordinates.
    const fw = o.freeform.w > 0 ? o.freeform.w : o.w, fh = o.freeform.h > 0 ? o.freeform.h : o.h;
    const path = (o.freeform.paths ?? []).find(q => q.closed && q.pts.length >= 3);
    return path && fw > 0 && fh > 0 ? path.pts.map(([x, y]) => [x / fw, y / fh]) : null;
  }
  if (o?.type === 'shape') return shapeOutline(o.kind ?? 'rectangle', o.w, o.h, o.corner ?? null);
  return null;
}

/**
 * The areas text keeps clear of round a floating object (wrap_areas): one rectangle, or for Tight and Through a stack of narrow
 * bands that follow the object's contour (its outline turned and flipped as the object is, each band as wide as the outline is at
 * its widest there, plus the distance from text). wordcraft's layout wraps these round the rectangle (its contour.rs is not
 * translated); the bands are ours, from the shape outline, not checked against upstream.
 */
export function wrapAreas(r, f, o = null) {
  const base = wrapArea(r, f);
  if (!base) return [];
  const wrap = f.wrap ?? 'inline';
  const unit = wrap === 'tight' || wrap === 'through' ? contourOf(o, f) : null;
  if (!unit) return [base];
  const d = v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0);
  const side = d(f.dist), top = d(f.distTop), bottom = d(f.distBottom);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, t = ((f.rot ?? 0) * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const pts = unit.map(([ux, uy]) => {
    const x = (f.flipH ? 1 - ux : ux) * r.w - r.w / 2, y = (f.flipV ? 1 - uy : uy) * r.h - r.h / 2;
    return [cx + x * cos - y * sin, cy + x * sin + y * cos];
  });
  const ys = pts.map(p => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  if (!(hi - lo > 1)) return [base];
  // How far across the outline reaches at height y: [min x, max x], or null above and below it.
  const span = y => {
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
        const x = y1 === y0 ? Math.min(x0, x1) : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        a = Math.min(a, x); b = Math.max(b, y1 === y0 ? Math.max(x0, x1) : x);
      }
    }
    return a <= b ? [a, b] : null;
  };
  const step = Math.max((hi - lo) / 60, 2);
  const bands = [];
  for (let y = lo; y < hi; y += step) {
    const y1 = Math.min(y + step, hi);
    let a = Infinity, b = -Infinity;
    for (const yy of [y + 0.01, (y + y1) / 2, y1 - 0.01]) { const s = span(yy); if (s) { a = Math.min(a, s[0]); b = Math.max(b, s[1]); } }
    if (a > b) continue;
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.a - a) < 0.5 && Math.abs(last.b - b) < 0.5 && Math.abs(last.y1 - y) < 0.01) last.y1 = y1; else bands.push({a, b, y0: y, y1});
  }
  if (!bands.length) return [base];
  return bands.map((bd, i) => ({rect: rect(bd.a - side, bd.y0 - (i === 0 ? top : 0), bd.b - bd.a + side * 2, bd.y1 - bd.y0 + (i === 0 ? top : 0) + (i === bands.length - 1 ? bottom : 0)),
    topBottom: false, side: f.wrapText ?? 'bothSides', table: false}));
}

/** Wrap areas relative to a paragraph whose column starts at x0 and top is y0 (rel_exclusions). */
export function relExclusions(excl, x0, y0) {
  const out = [];
  for (const a of excl) {
    const e = {top: a.rect.y - y0, bottom: a.rect.y + a.rect.h - y0, left: a.rect.x - x0, right: a.rect.x + a.rect.w - x0, topBottom: a.topBottom,
      side: a.side, table: a.table};
    if (e.bottom > 0) out.push(e);
  }
  return out;
}

/** Which objects of `p` the layout leaves out (left_out_objects): f(objectIndex) -> bool. */
export function leftOutObjects(doc, p, tableChr, showHidden, hideDeleted) {
  const out = [];
  let k = 0, s = 0;
  for (const r of p.runs) {
    const end = s + r.len;
    for (let i = p.text.indexOf('￼', s); i >= 0 && i < end; i = p.text.indexOf('￼', i + 1)) {
      const rc = doc.resolveChar(p.props?.style ?? null, r.props ?? {}, tableChr);
      out[k++] = leftOut(doc, rc, showHidden, hideDeleted) || !!p.objects?.[k - 1]?.float?.hidden;
    }
    s = end;
  }
  return i => !!out[i];
}

/** Text measured with the layout's shaper, for the chart renderer (one object for each shaper). */
const measures = new WeakMap();
const measureOf = shaper => {
  let m = measures.get(shaper);
  if (!m) { m = {textWidth: (text, size, bold) => shaper.advance(String(text), {family: 'Calibri', size, bold: !!bold, italic: false})}; measures.set(shaper, m); }
  return m;
};
const themes = new WeakMap();
const themeOf = colors => {
  let g = colors && themes.get(colors);
  if (!g) { g = gridTheme(colors); if (colors) themes.set(colors, g); }
  return g;
};

/** The items that draw drawing `o` at `r` (float_items): a picture, a shape, a text box's frame and text. */
export function objectItems(ctx, o, r, {story, path, off, depth = 0}) {
  const rot = o.float?.rot ?? 0;
  const items = [];
  if (o.type === 'image') items.push({kind: 'image', rect: r, media: o.media ?? '', crop: o.crop ?? [0, 0, 0, 0], story, path, off, rot, alt: o.alt ?? '',
    ...(o.look?.pad > 0 && o.look.drawn === o.media ? {pad: o.look.pad} : {}),
    ...(o.float?.flipH ? {flipH: true} : {}), ...(o.float?.flipV ? {flipV: true} : {}), ...(o.effects ? {effects: o.effects} : {})});
  else if (o.type === 'graphic' && o.graphic?.chart) {
    const prims = chartPrims(o.graphic.chart, r.w, r.h, themeOf(ctx.doc.settings?.themeColors), measureOf(ctx.shaper));
    items.push({kind: 'chart', rect: r, prims, family: ctx.doc.settings?.minorFont ?? 'Calibri', rot, story, path, off, alt: o.alt ?? ''});
  } else if (o.type === 'graphic' && o.graphic?.smartArt) {
    // SmartArt: PowerPoint's layout engine's shapes, flattened into the same primitives a chart is drawn with (U:quill/smartart).
    const prims = smartArtPrims(o.graphic.smartArt, r.w, r.h, ctx.doc.settings?.themeColors, measureOf(ctx.shaper));
    items.push({kind: 'chart', rect: r, prims, family: ctx.doc.settings?.minorFont ?? 'Calibri', rot, story, path, off, alt: o.alt ?? ''});
  } else if (o.type === 'shape' || o.type === 'group' || o.type === 'graphic') {
    const cv = o.type === 'group' ? o.canvas ?? null : null;
    // A fill with a transparency or a gradient (Shape Format › Shape Fill) is `fillFx`; `fill` stays the one colour standing for it.
    const fl = cv ? cv.fill ?? null : o.fill ?? null;
    const fillFx = fl && !Array.isArray(fl) ? fillForm(fl) : null;
    items.push({kind: 'shape', rect: r, shape: o.type === 'shape' ? o.kind ?? 'rectangle' : 'frame', fill: fillFx ? fillMainColor(fillFx) : fl, ...(fillFx ? {fillFx} : {}),
      ...(o.type === 'shape' && o.effects ? {effects: o.effects} : {}), stroke: cv ? cv.stroke ?? null : o.stroke ?? null,
      strokeWidth: cv ? cv.strokeWidth ?? 0.75 : Number.isFinite(o.strokeWidth) ? o.strokeWidth : o.type === 'shape' ? 0.75 : 0, rot, story, path, off, graphic: o.type === 'graphic' ? o : null,
      // Freeform geometry (ink strokes, lines and polygons made by Ink to Shape), the flips and a line's arrowheads (U:quill/draw).
      ...(o.type === 'shape' ? {freeform: o.kind === 'freeform' ? o.freeform ?? null : null, flipH: !!o.float?.flipH, flipV: !!o.float?.flipV,
        arrowStart: !!o.extra?.arrowStart, arrowEnd: !!o.extra?.arrowEnd} : {})});
    const id = o.type === 'shape' ? o.story : null;
    if (id !== null && id !== undefined && ctx.doc.part(id) && depth < 4) items.push(...textBoxItems(ctx, id, r, depth, o.extra?.warp));
  }
  // A group (Layout › Arrange › Group) draws its members in its frame; a drawing canvas holds its members the same way.
  if (o.type === 'group' && depth < 4) {
    for (const [[x, y, w, h], c] of groupRects(o, r.x, r.y, r.w, r.h)) {
      items.push(...objectItems(ctx, c, rect(x, y, w, h), {story, path, off, depth: depth + 1}).filter(i => i.kind !== 'object'));
    }
  }
  items.push({kind: 'object', rect: r, rot, story, path, off, textBox: o.type === 'shape' ? o.story ?? null : null, wrap: o.float?.wrap ?? 'inline',
    origin: {x: r.x, y: r.y}});
  return items;
}

/**
 * Stacked text (Shape Format › Text Direction › Stacked): each letter of a paragraph on a line of its own, upright
 * (a:bodyPr vert="wordArtVert"). The paragraphs' runs keep their formatting; objects stay in order.
 */
function stackBlocks(blocks) {
  return blocks.map(blk => {
    if (blk.kind !== 'para' || !blk.text) return blk;
    let text = '';
    const runs = [];
    let at = 0;
    const total = blk.text.length;
    for (const r of blk.runs ?? [{len: total}]) {
      let len = 0;
      for (const ch of blk.text.slice(at, at + r.len)) {
        const last = at + len + ch.length >= total;
        text += last ? ch : `${ch}\n`;
        len += ch.length + (last ? 0 : 1);
      }
      at += r.len;
      runs.push({...r, len});
    }
    return {...blk, text, runs};
  });
}

/** A text box's text laid out inside its frame (textbox.rs, single box; linked chains not followed). Turned text (vert, vert270) is laid out as if horizontal in the frame's other dimension and carries `turn` so it is drawn rotated. */
function textBoxItems(ctx, id, r, depth, warp = null) {
  const part = ctx.doc.part(id);
  const [l, t, rr, b] = textBodyInsetsPt(part.body);
  const vert = part.body?.vert ?? 'horz';
  const turned = vert === 'vert' || vert === 'vert270';
  // The text runs along the frame's height when turned: lines are that long, the box's width is what they stack in.
  const w = Math.max(turned ? r.h - t - b : r.w - l - rr, 1);
  ctx.boxes++;
  // eslint-disable-next-line no-use-before-define
  const laid = ctx.layoutBox({story: id, blocks: vert === 'stacked' ? stackBlocks(part.blocks ?? []) : part.blocks ?? [], prefix: [], width: w, cell: undefined, depth: depth + 1, frame: null});
  ctx.boxes--;
  const anchor = part.body?.anchor ?? 'top';
  const room = turned ? r.w - l - rr : r.h - t - b;
  const dy = anchor === 'center' ? Math.max((room - laid.height) / 2, 0) : anchor === 'bottom' ? Math.max(room - laid.height, 0) : 0;
  // Unturned, the content area's corner; turned, it is rotated about that corner onto the frame.
  const [fx, fy] = [r.x + l, r.y + t];
  const turn = !turned ? null : vert === 'vert' ? {deg: 90, tx: r.x + r.w - rr, ty: r.y + t, fx, fy} : {deg: -90, tx: r.x + l, ty: r.y + r.h - b, fx, fy};
  // A text warp (Shape Format › Text Effects › Transform) bends the text along its preset when the page is painted.
  const bend = warp && !/^text(NoShape|Plain)$/.test(warp.preset) ? {preset: warp.preset, adj: warp.adj ?? [], frame: {x: r.x, y: r.y, w: r.w, h: r.h}} : null;
  const out = [];
  for (const it of laid.items) {
    // Text that doesn't fit the box is hidden, as Word clips it (text_box_hides_text_that_does_not_fit).
    if (it.kind === 'lines') {
      const f = it.para.lines[it.l0];
      let l1 = it.l0;
      while (l1 < it.l1) { const ln = it.para.lines[l1]; if (it.y + ln.top - f.top + ln.height > room + 0.5) break; l1++; }
      if (l1 === it.l0) continue;
      out.push({...it, l1, x: it.x + fx, y: it.y + fy + dy, ...(turn ? {turn} : {}), ...(bend ? {warp: bend} : {})});
      continue;
    }
    const c = {...it, ...(turn ? {turn} : {})};
    if (c.kind === 'rule') { c.x0 += fx; c.x1 += fx; c.y0 += fy + dy; c.y1 += fy + dy; } else if (c.rect) c.rect = {...c.rect, x: c.rect.x + fx, y: c.rect.y + fy + dy};
    out.push(c);
  }
  return out;
}

/**
 * The items of the objects in lines l0..l1 of `pl` laid out at `origin` (place_objects): inline
 * drawings on their lines, floating ones at `floats` (object index -> rect). Returns [behind, front].
 */
export function placeObjects(ctx, req) {
  const {story, path, p, pl, lines: [l0, l1], origin: [x, y], floats, depth = 0} = req;
  const behind = [], front = [];
  if (!p.objects?.length) return [behind, front];
  const first = pl.lines[l0];
  if (!first) return [behind, front];
  for (let li = l0; li < l1; li++) {
    const l = pl.lines[li];
    for (let k = l.c0; k < l.c1; k++) {
      const c = pl.clusters[k];
      if (c.kind !== CL.OBJECT || c.obj < 0) continue;
      const o = p.objects[c.obj];
      if (!o) continue;
      const off = c.start;
      const fr = floats.get(c.obj);
      if (fr) {
        const items = objectItems(ctx, o, fr, {story, path, off, depth});
        (o.float?.wrap === 'behindText' ? behind : front).push(...items);
        continue;
      }
      // An equation sits on the baseline: its prims (laid out with the paragraph, lib/math-layout.mjs) in a frame of its ascent and descent.
      if (o.type === 'equation' && c.math) {
        const base = y + l.baseline - first.top;
        const r = rect(x + (l.clLeft(k) ?? 0), base - c.math.a, c.math.w, c.math.h);
        front.push({kind: 'math', rect: r, prims: c.math.prims, family: MATH_FONT, rot: 0, story, path, off, alt: o.linear ?? ''}, {kind: 'object', rect: r, rot: 0, story, path, off, textBox: null, wrap: 'inline', origin: {x: r.x, y: r.y}});
        continue;
      }
      if (c.objH <= 0 || isFloating(o) || !['image', 'graphic', 'shape', 'group'].includes(o.type)) continue;
      // Inline: on the baseline, inside its effect extents.
      const [el, et] = o.float?.effect ?? [0, 0, 0, 0];
      const cx = x + (l.clLeft(k) ?? 0);
      const base = y + l.baseline - first.top;
      const w = Math.max(c.adv - (el ?? 0) - (o.float?.effect?.[2] ?? 0), 0);
      const h = Math.max(c.objH - (et ?? 0) - (o.float?.effect?.[3] ?? 0), 0);
      const r = rect(cx + (el ?? 0), base - c.objH + (et ?? 0), w, h);
      front.push(...objectItems(ctx, o, r, {story, path, off, depth}));
    }
  }
  return [behind, front];
}
