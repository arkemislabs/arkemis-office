// Laying out a Word equation (Insert › Equation): the typeset form of an equation's linear-format text as drawing primitives,
// for the page view and the tests.
//
// Reuses Slate's equation model instead of translating wordcraft's math layout (layout/src/math, about 1,800 lines) again: the
// linear text is parsed by core/slate/lib/equation.mjs into its tree (fractions, scripts, roots, n-ary operators with limits,
// brackets, stacks, matrices, accents, function names), and this file turns that tree into boxes the way TeX sets math: a box has
// a width, an ascent and a descent; a fraction is a bar between two boxes on the math axis; a script is 70% of the size, raised or
// lowered by the base; a bracket grows with its content; an n-ary operator is a large glyph with its limits above and below
// (display equations) or beside it (in-line ones, and integrals).
//
// Where it differs from Slate (which hands the tree to the browser as MathML) and from wordcraft: the canvas draws the page, so
// the layout is ours; spacing is the TeX table reduced to binary operators and relations; italic Latin and Greek letters, upright
// digits, function names and symbols; brackets are the font's glyphs scaled to the content (Word builds them from pieces); a
// radical is drawn as a path. Not checked against Word's own spacing.
//
// Prim: the chart prims of core/grid/lib/chart-render.mjs (`text` with `italic` and `valign: 'baseline'`, `line` with `pts`),
// in points from the box's top left, so the page view paints them with the chart painter (src/shell/charts/prims.ts).
// No DOM, no Node built-ins.

import {parse, PLACEHOLDER} from '../../slate/lib/equation.mjs';

export const MATH_FONT = 'Cambria Math';
const ASC = 0.78, DESC = 0.22;
const RELATIONS = new Set([...'=≠≤≥≈≅≡∝≪≫∈∉∋⊂⊃⊆⊇→←↔⇒⇐⇔↦⟶⟵⟷∼≃<>≔⩵≝≜≞∴∵∥⊥']);
const BINARY = new Set([...'+−-±∓×÷∙∘∗∪∩∧∨⊕⊖⊗⊘⊙⋅⋆∖']);
const UP_LIMITS = new Set([...'∑∏∐⋃⋂']);
const ACCENT_TEXT = {'̇': '˙', '̈': '¨', '̂': 'ˆ', '̌': 'ˇ', '́': '´', '̀': '`', '̃': '˜', '̆': '˘', '⃗': '→'};
const LETTER = /^\p{L}$/u;

const box = (w, a, d, prims = []) => ({w, a, d, prims});
const shift = (prims, dx, dy) => prims.map(p => (p.t === 'text' ? {...p, x: p.x + dx, y: p.y + dy} : p.t === 'line' ? {...p, pts: p.pts.map(([x, y]) => [x + dx, y + dy])} : p));

/** Lay out `tree` (core/slate/lib/equation.mjs `parse`) at `size` points. `o`: {advance(text, size, italic, bold), color, display}. */
class Typesetter {
  constructor(o) { this.advance = o.advance; this.color = o.color ?? [0, 0, 0, 255]; this.display = !!o.display; }

  text(str, size, {italic = false, bold = false} = {}) {
    const w = this.advance(str, size, italic, bold);
    return box(w, size * ASC, size * DESC, [{t: 'text', x: 0, y: 0, text: str, size, italic, bold, color: this.color, align: 'left', valign: 'baseline'}]);
  }
  line(pts, size, width = 0.06) { return {t: 'line', pts, color: this.color, width: Math.max(0.4, width * size), dash: false}; }
  space(w) { return box(w, 0, 0); }

  row(boxes) {
    let x = 0, a = 0, d = 0;
    const prims = [];
    for (const b of boxes) {
      prims.push(...shift(b.prims, x, 0));
      x += b.w; a = Math.max(a, b.a); d = Math.max(d, b.d);
    }
    return box(x, a, d, prims);
  }

  /** A node at `size` (style: the script level shrinks it). */
  node(n, size, level = 0) {
    if (Array.isArray(n)) return this.row(n.map(x => this.node(x, size, level)));
    switch (n.t) {
      case 'num': return this.text(n.v, size);
      case 'id': return n.v === PLACEHOLDER ? this.placeholder(size) : this.text(n.v, size, {italic: LETTER.test(n.v) && !/[ℂℍℕℙℚℝℤℓℏℑℜ℘ℵ]/.test(n.v)});
      case 'fn': return this.row([this.text(n.v, size), this.space(size * 0.17)]);
      case 'sym': return this.symbol(n.v === '-' ? '−' : n.v, size);
      case 'row': return this.row(n.items.map(x => this.node(x, size, level)));
      case 'frac': return this.frac(n, size, level);
      case 'sup': return this.scripts(this.node(n.base, size, level), null, this.node(n.sup, this.small(size), level + 1), size);
      case 'sub': return this.scripts(this.node(n.base, size, level), this.node(n.sub, this.small(size), level + 1), null, size);
      case 'subsup': return this.scripts(this.node(n.base, size, level), this.node(n.sub, this.small(size), level + 1), this.node(n.sup, this.small(size), level + 1), size);
      case 'sqrt': return this.sqrt(n, size, level);
      case 'nary': return this.nary(n, size, level);
      case 'fenced': return this.fenced(n, size, level);
      case 'stack': return this.table(n.rows.map(r => [this.node(r, size, level)]), size);
      case 'matrix': return this.table(n.rows.map(r => r.map(c => this.node(c, size, level))), size);
      case 'accent': return this.accent(n, size, level);
      default: return this.space(0);
    }
  }
  small(size) { return Math.max(size * 0.7, 5); }

  placeholder(size) {
    const w = size * 0.62, h = size * 0.8, x0 = size * 0.06;
    const p = {t: 'line', pts: [[x0, 0], [x0, -h], [x0 + w, -h], [x0 + w, 0], [x0, 0]], color: [128, 128, 128, 255], width: Math.max(0.4, size * 0.05), dash: true};
    return box(w + 2 * x0, h, 0, [p]);
  }

  symbol(ch, size) {
    const pad = RELATIONS.has(ch) ? size * 0.28 : BINARY.has(ch) ? size * 0.22 : ch === ',' ? size * 0.05 : 0;
    const t = this.text(ch, size, {italic: LETTER.test(ch) && !/[ℂℍℕℙℚℝℤℓℏℑℜ℘ℵ]/.test(ch)});
    if (!pad) return t;
    return this.row([this.space(pad), t, this.space(pad)]);
  }

  frac(n, size, level) {
    const s = this.display || level === 0 ? size : size;
    const inner = level > 0 ? this.small(size) : s;
    const num = this.node(n.n, inner, level + 1), den = this.node(n.d, inner, level + 1);
    const axis = size * 0.28, t = Math.max(0.5, size * 0.055), gap = size * 0.14;
    const w = Math.max(num.w, den.w) + size * 0.2;
    const numY = -(axis + t / 2 + gap + num.d);
    const denY = -axis + t / 2 + gap + den.a;
    const prims = [...shift(num.prims, (w - num.w) / 2, numY), ...shift(den.prims, (w - den.w) / 2, denY), {t: 'line', pts: [[size * 0.05, -axis], [w - size * 0.05, -axis]], color: this.color, width: t, dash: false}];
    return box(w, -numY + num.a, denY + den.d, prims);
  }

  scripts(base, sub, sup, size) {
    const s = this.small(size);
    let x = base.w, a = base.a, d = base.d;
    const prims = [...base.prims];
    const supUp = sup ? Math.max(size * 0.4, base.a - size * 0.5) : 0;
    const subDown = sub ? Math.max(size * 0.2, base.d + size * 0.12) : 0;
    let wSup = 0, wSub = 0;
    if (sup) { prims.push(...shift(sup.prims, x, -supUp)); wSup = sup.w; a = Math.max(a, supUp + sup.a); d = Math.max(d, sup.d - supUp); }
    if (sub) { prims.push(...shift(sub.prims, x, subDown)); wSub = sub.w; d = Math.max(d, subDown + sub.d); a = Math.max(a, sub.a - subDown); }
    if (sup && sub) {
      const gapNeeded = size * 0.12 - ((subDown - sub.a) - (supUp - sup.d));
      if (gapNeeded > 0) {
        // Spread the scripts apart when they would touch.
        const up = gapNeeded / 2;
        prims.length = base.prims.length;
        prims.push(...shift(sup.prims, x, -(supUp + up)), ...shift(sub.prims, x, subDown + up));
        a = Math.max(base.a, supUp + up + sup.a); d = Math.max(base.d, subDown + up + sub.d);
      }
    }
    void s;
    return box(x + Math.max(wSup, wSub) + size * 0.03, a, d, prims);
  }

  sqrt(n, size, level) {
    const arg = this.node(n.arg, size, level);
    const idx = n.index ? this.text(n.index, size * 0.55) : null;
    const t = Math.max(0.5, size * 0.06);
    const pad = size * 0.12;
    const rw = size * 0.62;
    const top = -(arg.a + pad), bottom = arg.d + size * 0.04;
    const h = bottom - top;
    const ix = idx ? Math.max(idx.w - rw * 0.35, 0) : 0;
    const x0 = ix;
    const pts = [[x0, bottom - h * 0.42], [x0 + rw * 0.16, bottom - h * 0.46], [x0 + rw * 0.46, bottom], [x0 + rw * 0.92, top], [x0 + rw + arg.w + size * 0.08, top]];
    const prims = [{t: 'line', pts, color: this.color, width: t, dash: false}, ...shift(arg.prims, x0 + rw, 0)];
    if (idx) prims.push(...shift(idx.prims, 0, top + h * 0.38));
    return box(x0 + rw + arg.w + size * 0.08, -top, bottom, prims);
  }

  nary(n, size, level) {
    const big = (this.display && level === 0) ? 1.45 : 1.2;
    const gs = size * big;
    const glyph = this.text(n.op, gs);
    const axis = size * 0.28;
    // The glyph sits on the math axis.
    const gy = -axis + gs * 0.3;
    const g = box(glyph.w, -gy + glyph.a, gy + glyph.d, shift(glyph.prims, 0, gy));
    const sideScripts = !UP_LIMITS.has(n.op) || !(this.display && level === 0);
    const s = this.small(size);
    const sub = n.sub ? this.node(n.sub, s, level + 1) : null, sup = n.sup ? this.node(n.sup, s, level + 1) : null;
    if (!sub && !sup) return g;
    if (sideScripts) {
      const up = Math.max(g.a * 0.8 - size * 0.1, size * 0.5), dn = Math.max(g.d + size * 0.1, size * 0.3);
      let w = g.w, a = g.a, d = g.d;
      const prims = [...g.prims];
      if (n.op === '∫' || n.op === '∬' || n.op === '∭' || n.op === '∮') w += gs * 0.1;
      if (sup) { prims.push(...shift(sup.prims, w, -up)); a = Math.max(a, up + sup.a); }
      if (sub) { prims.push(...shift(sub.prims, w, dn)); d = Math.max(d, dn + sub.d); }
      return box(w + Math.max(sup?.w ?? 0, sub?.w ?? 0) + size * 0.05, a, d, prims);
    }
    const w = Math.max(g.w, sub?.w ?? 0, sup?.w ?? 0) + size * 0.06;
    const gap = size * 0.1;
    const prims = shift(g.prims, (w - g.w) / 2, 0);
    let a = g.a, d = g.d;
    if (sup) { const y = -(g.a + gap + sup.d); prims.push(...shift(sup.prims, (w - sup.w) / 2, y)); a = -y + sup.a; }
    if (sub) { const y = g.d + gap + sub.a; prims.push(...shift(sub.prims, (w - sub.w) / 2, y)); d = y + sub.d; }
    return box(w, a, d, prims);
  }

  /** A bracket of the font, scaled to span `a` above the baseline and `d` below it. */
  bracket(ch, a, d, size) {
    const span = a + d;
    const gs = Math.max(size, span * 1.02);
    const g = this.text(ch, gs);
    const center = (d - a) / 2;
    const y = center + gs * (ASC - DESC) / 2;
    return box(g.w, Math.max(a, -y + g.a), Math.max(d, y + g.d), shift(g.prims, 0, y));
  }

  fenced(n, size, level) {
    const content = (Array.isArray(n.content) ? n.content : [n.content]).map(x => this.node(x, size, level));
    const inner = this.row(content);
    const a = Math.max(inner.a, size * ASC), d = Math.max(inner.d, size * DESC);
    const l = n.open ? this.bracket(n.open, a, d, size) : this.space(0);
    const r = n.close ? this.bracket(n.close, a, d, size) : this.space(0);
    const body = box(inner.w, inner.a, inner.d, inner.prims);
    const out = this.row([l, body, r]);
    out.a = Math.max(out.a, a); out.d = Math.max(out.d, d);
    return out;
  }

  table(rows, size) {
    const cols = Math.max(1, ...rows.map(r => r.length));
    const widths = Array.from({length: cols}, (_, c) => Math.max(0, ...rows.map(r => r[c]?.w ?? 0)));
    const gapX = size * 0.8, gapY = size * 0.25;
    const heights = rows.map(r => ({a: Math.max(size * ASC, ...r.map(b => b.a)), d: Math.max(size * DESC, ...r.map(b => b.d))}));
    const total = heights.reduce((s, h) => s + h.a + h.d, 0) + gapY * (rows.length - 1);
    const axis = size * 0.28;
    let y = -(total / 2 + axis);
    const prims = [];
    rows.forEach((r, i) => {
      const base = y + heights[i].a;
      let x = 0;
      r.forEach((b, c) => { prims.push(...shift(b.prims, x + (widths[c] - b.w) / 2, base)); x += widths[c] + gapX; });
      y += heights[i].a + heights[i].d + gapY;
    });
    const w = widths.reduce((s, v) => s + v, 0) + gapX * (cols - 1);
    return box(w, total / 2 + axis, total / 2 - axis, prims);
  }

  accent(n, size, level) {
    const base = this.node(n.base, size, level);
    const mark = ACCENT_TEXT[n.mark] ?? n.mark;
    if (n.mark === '̄') {
      const y = -(base.a + size * 0.1);
      return box(base.w, base.a + size * 0.15, base.d, [...base.prims, this.line([[0, y], [base.w, y]], size, 0.05)]);
    }
    const m = this.text(mark, size * 0.9);
    const y = -(base.a - size * 0.12);
    return box(base.w, Math.max(base.a, -y + m.a * 0.6), base.d, [...base.prims, ...shift(m.prims, (base.w - m.w) / 2, y)]);
  }
}

/**
 * The equation as a box: {w, a, d, h, prims}, prims from the top left (the baseline at y = a). `o`: {size, advance, color, display, format, normalText}.
 * An empty equation shows Word's placeholder text.
 */
export function layoutEquation(linear, o) {
  const size = Math.max(4, Math.min(400, Number(o.size) || 11));
  const ts = new Typesetter(o);
  const text = String(linear ?? '');
  let b;
  if (!text.trim()) {
    b = ts.text('Type equation here.', size);
    b.prims[0].color = [128, 128, 128, 255];
  } else if (o.format === 'linear' || o.normalText) {
    b = ts.text(text, size, {italic: false});
  } else {
    try { b = ts.node(parse(text), size, 0); } catch { b = ts.text(text, size); }
  }
  const a = Math.max(b.a, size * ASC), d = Math.max(b.d, size * DESC);
  return {w: b.w, a, d, h: a + d, prims: shift(b.prims, 0, a)};
}
