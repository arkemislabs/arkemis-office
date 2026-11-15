// Shaping a paragraph's runs into clusters through the shaper interface.
//
// Translated from wordcraft crates/layout/src/para/builder.rs and para/chars.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Where upstream picks font faces (fallback,
// East Asian, complex-script and Thai faces) and shapes glyph runs with rustybuzz, this builder
// picks the family the same way (complex-script font for complex-script characters, the East Asian
// font for CJK when set, symbol fonts drawn as their Unicode equivalents) and asks the shaper for
// each grapheme cluster's advance. Font fallback inside a family is the shaper's (the browser's).
import {clusterStarts} from '../../model/text.mjs';
import {resolvedComplex, resolvedDrawSize, resolvedBaselineShift} from '../../model/styles.mjs';
import {isSymbolFont, symbolChar} from '../../model/symbol-fonts.mjs';
import {CL, cluster} from './model.mjs';
import {isEastAsian} from './linebreak.mjs';
import {bidiLevels, strongRtl, visualOrder} from './bidi.mjs';

export const SOFT_HYPHEN = '­';

/** Is `c` (code point) formatted with the complex-script properties in a run formatted `rc` (uses_complex)? */
const isComplexScript = c => (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)
  || (c >= 0x10800 && c <= 0x10fff) || (c >= 0x1e800 && c <= 0x1efff) || (c >= 0x0900 && c <= 0x0eff);
export const usesComplex = (rc, c) => rc.rtl || rc.cs || isComplexScript(c);

/** Whether a run formatted `rc` is left out of the layout (left_out): hidden, or a hidden deletion. */
export function leftOut(doc, rc, showHidden, hideDeleted) {
  return (rc.hidden && !showHidden) || hides(doc, hideDeleted, rc.del) || hidesInserted(hideDeleted, rc.ins);
}
/** Whether inserted text is left out: Display for Review › Original shows the text before the changes (U:quill/review). */
export const hidesInserted = (hd, ins) => !!hd?.inserted && ins !== null && ins !== undefined;
/** Whether text deleted by revision `del` is left out (HideDeleted::hides). */
export function hides(doc, hd, del) {
  if (del === null || del === undefined || !hd) return false;
  const moved = !!doc.content.revisions?.[del]?.moveName;
  return moved ? !!hd.movedFrom : !!hd.plain;
}

/** The first character of `c`'s capital (upper_char). */
const upperChar = s => { const u = s.toUpperCase(); return [...u][0] ?? s; };
const isLower = s => s !== s.toUpperCase() && s === s.toLowerCase();
/** The text drawn for `s` in a run formatted `rc` (caps_char / push_caps): All Caps draws a letter's full capital. */
export const capsText = (rc, s) => (rc.caps || (rc.smallCaps && isLower(s)) ? s.toUpperCase() : s);
export const capsChar = (rc, s) => (rc.caps || (rc.smallCaps && isLower(s)) ? upperChar(s) : s);

const HINDI = d => String.fromCodePoint(0x660 + (d.charCodeAt(0) - 48));
/** The displayed form of digit `s` (NumeralMode::map). */
function numeralChar(mode, s, rtl) {
  const hindi = mode === 'hindi' || (mode === 'context' && rtl);
  return hindi && s >= '0' && s <= '9' && s.length === 1 ? HINDI(s) : s;
}

/** A face at a size with the formatting needed to draw it (StyleRun). */
function styleRun(shaper, rc, font, small) {
  const draw = resolvedDrawSize(rc) * (small ? 0.8 : 1);
  const spec = {family: font, size: draw, bold: !!rc.bold, italic: !!rc.italic};
  const m = shaper.metrics(spec);
  return {font: spec, size: draw, rc, ascent: m.ascent, descent: m.descent, shift: resolvedBaselineShift(rc), small};
}

/** How far a style reaches above and below the baseline (StyleRun::line_extent). */
export function lineExtent(st) {
  const draw = resolvedDrawSize(st.rc);
  const k = draw > 0 ? st.rc.size / draw : 1;
  const raise = st.rc.position;
  return [st.ascent * k * (st.small ? 1 / 0.8 : 1) + Math.max(raise, 0), st.descent * k * (st.small ? 1 / 0.8 : 1) + Math.max(-raise, 0)];
}

export class Builder {
  constructor(env, levels) {
    this.env = env;
    this.shaper = env.shaper;
    this.styles = [];
    this.styleIndex = new Map();
    this.clusters = [];
    this.levels = levels;
    /** Text drawn by clusters standing for an object: [clusterIndex, text]. */
    this.shown = [];
  }

  /** Style index for `rc` drawn in `family` (small: small-caps size). */
  style(rc, family = null, small = false) {
    const fam = family ?? rc.font;
    let bucket = this.styleIndex.get(rc);
    if (!bucket) { bucket = []; this.styleIndex.set(rc, bucket); }
    for (const [i, f, s] of bucket) if (f === fam && s === small) return i;
    const i = this.styles.length;
    this.styles.push(styleRun(this.shaper, rc, fam, small));
    bucket.push([i, fam, small]);
    return i;
  }

  /** Shape `text` (a piece of the paragraph from offset `base`) in one format. `dir`: 'para' | levels array | 'guess'. */
  shape(text, base, rc, kindOverride = null, dir = 'para') {
    if (!text) return;
    const levels = dir === 'para' ? this.levels : Array.isArray(dir) ? dir : [];
    const lbase = dir === 'para' ? base : 0;
    const useLevels = levels.length > 0;
    const sym = isSymbolFont(rc.font);
    let rcCs = null;
    const bounds = clusterStarts(text);
    const spacing = rc.spacing;
    const hscale = rc.scale / 100;
    for (let bi = 0; bi < bounds.length; bi++) {
      const gs = bounds[bi], ge = bi + 1 < bounds.length ? bounds[bi + 1] : text.length;
      const s = text.slice(gs, ge);
      const c = s.codePointAt(0);
      const rtl = useLevels && (levels[lbase + gs] ?? 0) % 2 === 1;
      const complex = usesComplex(rc, c);
      let r = rc;
      if (complex) r = rcCs ??= resolvedComplex(rc);
      let family = r.font;
      if (!complex && rc.fontEa && isEastAsian(c)) family = rc.fontEa;
      // Symbol-font characters are laid out as their Unicode equivalents.
      let shown = sym ? [...s].map(ch => symbolChar(rc.font, ch) ?? ch).join('') : s;
      if (shown === ' ') shown = ' ';
      const small = !!(r.smallCaps && !r.caps && isLower(s));
      if (!sym) shown = capsText(r, shown);
      shown = [...shown].map(ch => numeralChar(this.env.numeral, ch, rtl)).join('');
      const si = this.style(r, family, small);
      const st = this.styles[si];
      const kind = kindOverride ?? (s === ' ' || s === '　' ? CL.SPACE : s === SOFT_HYPHEN ? CL.MARKER : CL.TEXT);
      const adv = kind === CL.MARKER ? 0 : this.shaper.advance(shown, st.font) * hscale + spacing;
      const cl = cluster(base + gs, base + ge, adv, kind, si, kind === CL.MARKER ? '' : shown);
      cl.dot = s === '.' || s === ',';
      this.clusters.push(cl);
    }
  }

  /** One cluster for a whole object with its display text (shape_atomic): fields, note references. */
  shapeAtomic(text, start, end, rc) {
    const around = (this.levels[start] ?? 0) % 2 === 1;
    let rtlBase = around;
    for (const ch of text) { const s = strongRtl(ch.codePointAt(0)); if (s !== null) { rtlBase = s; break; } }
    const lv = bidiLevels(text, rtlBase);
    const before = this.clusters.length;
    this.shape(text, start, rc, null, lv.length ? lv : 'guess');
    const added = this.clusters.splice(before);
    if (!added.length) {
      const si = this.style(rc);
      this.clusters.push(cluster(start, end, 0, CL.MARKER, si, ''));
      return;
    }
    const adv = added.reduce((s, c) => s + c.adv, 0);
    const shown = added.map(c => c.shown).join('');
    const cl = cluster(start, end, adv, CL.TEXT, added[0].style, shown);
    // The pieces keep their own styles for drawing (a field result in two fonts).
    cl.pieces = added.map(c => ({style: c.style, shown: c.shown, adv: c.adv}));
    this.clusters.push(cl);
    this.shown.push([this.clusters.length - 1, text]);
  }
}

/** The list label's text, shaped in its own clusters (shape_label); returned in visual order. */
export function shapeLabel(b, text, rc, bidi) {
  const lv = bidi ? bidiLevels(text, true) : [];
  const before = b.clusters.length;
  b.shape(text, 0, rc, null, lv.length ? lv : 'guess');
  let cl = b.clusters.splice(before);
  if (lv.length) {
    const order = visualOrder(cl.map(c => lv[c.start] ?? 1));
    cl = order.map(i => cl[i]);
  }
  return cl;
}
