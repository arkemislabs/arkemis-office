// One paragraph laid out: runs shaped into clusters, objects, breaks, the list label, the drop cap,
// break opportunities, then lines.
//
// Translated from wordcraft crates/layout/src/para/paragraph.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: equations' own layout (`math/*`: an
// equation is typeset from its linear text by lib/math-layout.mjs, on Slate's equation tree, and
// shows that text when it cannot be), legacy form check boxes (they show
// their field result), proofing squiggles (`proof.rs`), automatic hyphenation (`wordcraft_proof`).
import {charOverlaid} from '../../model/props.mjs';
import {controlLabel} from '../../model/ranges.mjs';
import {resolvePara, setCharUnit, indentsOverList} from '../../model/styles.mjs';
import {defaultBullet} from '../../model/numbering.mjs';
import {clusterStarts} from '../../model/text.mjs';
import {asNoteSeparator, isDrawing} from '../../model/para.mjs';
import {mapText} from '../../model/symbol-fonts.mjs';
import {CL, ParaLayout, cluster, binHas} from './model.mjs';
import {Builder, SOFT_HYPHEN, capsChar, hides, hidesInserted, leftOut, shapeLabel} from './builder.mjs';
import {bidiLevels} from './bidi.mjs';
import {breakPositions} from './linebreak.mjs';
import {hyphenationPoints} from './justify.mjs';
import {proofLang} from '../../lib/hyphen.mjs';
import {autoSpace, breakLines, snapChars} from './lines.mjs';
import {isMergeInstr} from '../../lib/mailings-merge.mjs';
import {legacyFormText} from '../../model/legacy-form.mjs';
import {layoutEquation, MATH_FONT} from '../../lib/math-layout.mjs';
import {FIELD_SHADING, fieldCodeText, fieldTextOn, noteMark, pageAt, referenceLink} from '../fields.mjs';

const OBJ = '￼';
const LINE_BREAK = '\n', PAGE_BREAK = '\u000C', COLUMN_BREAK = '\u000E';
/** Width of a short note separator line (NOTE_SEP_W). */
export const NOTE_SEP_W = 144;

const isSpecial = c => c === '\t' || c === LINE_BREAK || c === PAGE_BREAK || c === COLUMN_BREAK || c === OBJ || c === '\r';

/** The paragraph's formatting: its style's, the table's and the list level's indents (paragraph_props). */
export function paragraphProps(p, env) {
  const doc = env.doc;
  let rp = resolvePara(doc.styles, p.props ?? {}, env.table?.para ?? null);
  if (Number.isFinite(env.readLineSpacing) && env.readLineSpacing >= 1 && env.readLineSpacing <= 2) rp = {...rp, lineSpacing: {rule: 'multiple', value: env.readLineSpacing}};
  if (rp.indentChars.some(c => c !== 0)) rp = setCharUnit(rp, doc.resolveChar(p.props?.style ?? null, p.mark ?? {}, env.table?.chr ?? null).size);
  else rp = {...rp};
  listIndents(rp, p, env);
  return rp;
}

/** List level indents apply unless the paragraph or its style sets its own (list_indents). */
function listIndents(rp, p, env) {
  const pp = p.props ?? {};
  const ownLeft = pp.indentLeft !== undefined || (Number.isFinite(pp.indentLeftChars) && pp.indentLeftChars !== 0);
  const ownFirst = pp.indentFirst !== undefined || (Number.isFinite(pp.indentFirstChars) && pp.indentFirstChars !== 0);
  if (env.label) {
    const lvl = env.label[1];
    const [styleLeft, styleFirst] = pp.numbering ? [false, false] : indentsOverList(env.doc.styles, pp.style ?? 'Normal');
    if (!ownLeft && !styleLeft) rp.indentLeft = lvl.indent ?? 0;
    if (!ownFirst && !styleFirst) rp.indentFirst = -(lvl.hanging ?? 0);
  } else if (pp.numbering && pp.numbering.num === 0) {
    if (!ownLeft) rp.indentLeft = 0;
    if (!ownFirst) rp.indentFirst = 0;
  }
}

/** The first character, if it is to be a drop cap (drop_cap_char). */
function dropCapChar(p, rp) {
  if (!(rp.dropCap > 0) || !p.text) return null;
  const c = String.fromCodePoint(p.text.codePointAt(0));
  if (c === '\t' || c === LINE_BREAK || c === PAGE_BREAK || c === COLUMN_BREAK || c === OBJ || c === '\r' || c === ' ') return null;
  return p.text.length > c.length ? c : null;
}

class Shaped {
  constructor(b, eq) {
    Object.assign(this, {b, hasPageFields: false, notes: [], objIndex: 0, dropCap: null, dropCapW: 0, maths: [], rubies: [], displays: [], ptabs: [],
      eqCounter: eq, left: [], bare: []});
  }
  push(start, end, style, kind, adv, h = 0, d = 0) {
    const c = cluster(start, end, adv, kind, style);
    c.objH = h; c.objD = d;
    this.b.clusters.push(c);
    return c;
  }
  run(cx, start, end, props) {
    const rc = cx.res(props);
    const text = cx.p.text.slice(start, end);
    if (leftOut(cx.env.doc, rc, cx.env.showHidden, cx.env.hideDeleted)) this.leftOutRun(cx, rc, start, end, text);
    else this.visibleRun(cx, rc, props, start, text);
  }
  leftOutRun(cx, rc, start, end, text) {
    const last = this.left[this.left.length - 1];
    if (last && last[1] === start) last[1] = end; else this.left.push([start, end]);
    const si = this.b.style(rc);
    const keepsNotes = !hides(cx.env.doc, cx.env.hideDeleted, rc.del);
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i);
      const len = code > 0xffff ? 2 : 1;
      if (text[i] === OBJ) {
        const o = cx.p.objects?.[this.objIndex];
        if (o?.type === 'noteRef' && keepsNotes) this.notes.push([this.b.clusters.length, o.id]);
        this.objIndex++;
      }
      const c = this.push(start + i, start + i + len, si, CL.MARKER, 0);
      if (text[i] === OBJ) c.obj = this.objIndex - 1;
      i += len - 1;
    }
  }
  visibleRun(cx, rc, props, start, text) {
    let seg = this.dropCapLetter(cx, rc, text, start);
    for (let i = seg; i < text.length; i++) {
      const c = text[i];
      if (!isSpecial(c)) continue;
      if (i > seg) this.b.shape(text.slice(seg, i), start + seg, rc);
      seg = i + 1;
      const style = this.b.style(rc);
      this.special(cx, c, start + i, style, rc, props);
    }
    if (seg < text.length) this.b.shape(text.slice(seg), start + seg, rc);
  }
  dropCapLetter(cx, rc, text, start) {
    const rp = cx.rp;
    const c = cx.dropFirst;
    if (!c || start !== 0) return 0;
    if (!text.startsWith(c)) return 0;
    const lineH = Math.max(rc.size * 1.2, 1);
    const lines = rp.dropCap;
    const big = {...rc, size: Math.max(Math.min(((lines - 1) * lineH + rc.size * 0.7) / 0.7, 1000), rc.size)};
    if (rp.dropCapFont) big.font = rp.dropCapFont;
    const before = this.b.clusters.length;
    this.b.shape(c, 0, big);
    const added = this.b.clusters.slice(before);
    const w = added.reduce((s, k) => s + k.adv, 0);
    const indent = rp.dropCapMargin ? 0 : w + rp.dropCapDistance;
    this.dropCap = {clusters: this.b.clusters.length - before, lines: rp.dropCap, indent};
    this.dropCapW = w;
    for (const k of added) k.adv = 0;
    return c.length;
  }
  special(cx, c, at, style, rc, props) {
    if (c === '\t') this.push(at, at + 1, style, CL.TAB, 0);
    else if (c === LINE_BREAK || c === '\r') this.push(at, at + 1, style, CL.LINE_BREAK, 0);
    else if (c === PAGE_BREAK) this.push(at, at + 1, style, cx.env.table ? CL.MARKER : CL.PAGE_BREAK, 0);
    else if (c === COLUMN_BREAK) this.push(at, at + 1, style, CL.COLUMN_BREAK, 0);
    else { const k = this.objIndex++; this.object(cx, k, at, style, rc, props); }
  }
  object(cx, k, at, style, rc, props) {
    const o = cx.p.objects?.[k];
    if (!o) { this.bareMarker(at, style); return; }
    if (isDrawing(o)) { this.drawing(cx, k, o, at, style); return; }
    switch (o.type) {
      case 'field': this.field(cx, k, o, at, rc); return;
      case 'noteRef': this.noteRef(cx, o, at, rc); return;
      case 'equation': this.equation(cx, k, o, at, style, rc); return;
      case 'ruby': this.ruby(cx, k, o, at, rc, props); return;
      case 'opaque': {
        const sep = asNoteSeparator(o);
        if (sep !== null) {
          const maxw = Math.max(cx.env.width - Math.max(cx.rp.indentLeft, 0) - Math.max(cx.rp.indentRight, 0), 1);
          const c = this.push(at, at + 1, style, CL.OBJECT, sep ? maxw : Math.min(NOTE_SEP_W, maxw));
          c.obj = k;
          return;
        }
        this.b.shapeAtomic(o.text ?? '', at, at + 1, rc);
        return;
      }
      // Developer › Design Mode: a control's start and end tags stand in the line (Word draws them inline, pushing the text).
      case 'controlStart': case 'controlEnd': {
        if (!cx.env.designMode || (o.type === 'controlStart' && o.control?.appearance === 'hidden')) { this.bareMarker(at, style); return; }
        const tag = {...rc, size: Math.max(rc.size * 0.7, 6), bold: true, italic: false, color: {Rgb: [255, 255, 255]}, shading: [91, 141, 239], highlight: null, underline: null, strike: false};
        const closes = o.type === 'controlEnd' ? cx.env.endTags?.get(o) : null;
        this.b.shapeAtomic(o.type === 'controlStart' ? ` ${controlLabel(o.control)} ` : closes ? ` ${controlLabel(closes)} ` : ' \u203a ', at, at + 1, tag);
        const last = this.b.clusters[this.b.clusters.length - 1];
        if (last) last.obj = k;
        return;
      }
      case 'positionalTab': {
        this.push(at, at + 1, style, CL.TAB, 0);
        this.ptabs.push([this.b.clusters.length - 1, o.align ?? 'left', o.relativeTo ?? 'margin', o.leader ?? 'none']);
        return;
      }
      default: this.bareMarker(at, style);
    }
  }
  bareMarker(at, style) { this.bare.push([at, at + 1]); this.push(at, at + 1, style, CL.MARKER, 0); }
  drawing(cx, k, o, at, style) {
    const f = o.float ?? {};
    const env = cx.env;
    if ((f.wrap ?? 'inline') === 'inline' && !f.hidden) {
      const maxw = Math.max(env.width - Math.max(cx.rp.indentLeft, 0) - Math.max(cx.rp.indentRight, 0), 18);
      const fit = (env.fitted ?? []).find(([i]) => i === k);
      let w = Math.max(1, Math.min(4000, Number(o.w) || 1)), h = Math.max(1, Math.min(4000, Number(fit ? fit[1] : o.h) || 1));
      const s = env.fitObjects && w > maxw ? maxw / w : 1;
      const [el, et, er, eb] = (f.effect ?? [0, 0, 0, 0]).map(v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0));
      const [px, py] = spinPad(f, w * s, h * s);
      const c = this.push(at, at + 1, style, CL.OBJECT, w * s + el + er + 2 * px, h * s + et + eb + 2 * py);
      c.obj = k;
    } else {
      const c = this.push(at, at + 1, style, CL.OBJECT, 0);
      c.obj = k;
    }
  }
  field(cx, k, o, at, rc) {
    const env = cx.env;
    if (env.fieldCodes !== !!o.code) {
      const shaded = !rc.highlight && !rc.shading ? {...rc, shading: FIELD_SHADING} : rc;
      this.b.shapeAtomic(fieldCodeText(o.instr ?? ''), at, at + 1, shaded);
    } else {
      let [t, pageDep] = fieldTextOn(o.instr ?? '', o.result ?? '', env.fields, pageAt(env.fields, at));
      // A legacy check box or drop-down shows its state, as Word draws it (Developer > Legacy Tools).
      if (o.form) t = legacyFormText(o.instr ?? '', o.form, t);
      this.hasPageFields ||= pageDep;
      const link = referenceLink(o.instr ?? '');
      // Mailings › Highlight Merge Fields: the merge fields are shaded like the fields shown as codes (U:quill/mailings).
      const shade = env.mergeHighlight && !rc.highlight && !rc.shading && isMergeInstr(o.instr ?? '') ? {...rc, shading: FIELD_SHADING} : rc;
      this.b.shapeAtomic(t, at, at + 1, link && !shade.link ? {...shade, link} : shade);
    }
    const last = this.b.clusters[this.b.clusters.length - 1];
    if (last) last.obj = k;
  }
  noteRef(cx, o, at, rc) {
    const s = cx.env.doc.settings;
    const num = o.custom ? o.custom : noteMark(cx.env.fields, o.id, o.kind === 'endnote' ? s.endnoteFormat : s.footnoteFormat);
    this.b.shapeAtomic(num, at, at + 1, {...rc, vertAlign: 'superscript'});
    this.notes.push([this.b.clusters.length - 1, o.id]);
  }
  equation(cx, k, o, at, style, rc) {
    // The typeset form (lib/math-layout.mjs, on Slate's equation tree): a box in the line, its drawing primitives kept on the cluster
    // for the page view. Past the layout's limits (or text it cannot parse) the equation shows its linear text.
    const si = this.b.style(rc);
    const font = this.b.styles[si].font;
    const rgb = rc.color?.Rgb;
    let m = null;
    try {
      m = layoutEquation(o.linear ?? '', {size: font.size, display: !!o.display, format: o.format, normalText: !!o.normalText, color: rgb ? [rgb[0], rgb[1], rgb[2], 255] : [0, 0, 0, 255],
        advance: (text, size, italic, bold) => this.b.shaper.advance(text, {...font, family: MATH_FONT, size, italic: !!italic, bold: !!bold})});
    } catch { m = null; }
    if (!m || !Number.isFinite(m.w)) {
      this.b.shapeAtomic(o.linear ?? '', at, at + 1, rc);
      const c = this.b.clusters[this.b.clusters.length - 1];
      c.obj = k;
    } else {
      const c = this.push(at, at + 1, style, CL.OBJECT, m.w, m.a, m.d);
      c.obj = k;
      c.math = m;
      this.maths.push([k]);
    }
    if (o.display) this.displays.push([this.b.clusters.length - 1, o.math?.jc === 'left' || o.math?.jc === 'right' ? o.math.jc : 'center']);
  }
  ruby(cx, k, o, at, rc, props) {
    const rr = cx.res(charOverlaid(props ?? {}, o.props ?? {}));
    const size = Number.isFinite(o.size) ? Math.max(1, Math.min(1584, o.size)) : rc.size * 0.5;
    const r = {...rr, size, sizeCs: size, position: 0, vertAlign: 'baseline'};
    const raise = Number.isFinite(o.raise) ? Math.max(0, Math.min(1584, o.raise)) : rc.size;
    this.b.shapeAtomic(o.base ?? '', at, at + 1, rc);
    const ci = this.b.clusters.length - 1;
    const base = this.b.clusters[ci];
    base.obj = k;
    const si = this.b.style(r);
    const st = this.b.styles[si];
    const w = this.b.shaper.advance(o.ruby ?? '', st.font);
    if (w > base.adv) base.adv = w;
    base.objH = raise + st.ascent;
    this.rubies.push({cluster: ci, text: o.ruby ?? '', style: si, raise, width: w, align: o.align ?? 'center'});
  }
}

/** Extra room a rotated drawing's bounds take on each side (Float::spin_pad). */
function spinPad(f, w, h) {
  const rot = Number.isFinite(f.rot) ? f.rot : 0;
  if (!rot) return [0, 0];
  const t = rot * Math.PI / 180;
  const bw = Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t));
  const bh = Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t));
  return [Math.max(0, (bw - w) / 2), Math.max(0, (bh - h) / 2)];
}

/** The text break opportunities come from: the paragraph without what is left out (BreakText). */
function breakText(source, skip) {
  skip = skip.slice().sort((a, b) => a[0] - b[0]);
  if (!skip.length) return {text: source, toPara: i => i};
  let text = '';
  const ends = [];
  let s = 0;
  for (let i = 0; i < source.length; i++) {
    while (s < skip.length && skip[s][1] <= i) s++;
    if (s < skip.length && skip[s][0] <= i) continue;
    text += source[i];
    ends.push([text.length, i + 1]);
  }
  const map = new Map(ends);
  return {text, toPara: i => (i === 0 ? 0 : map.get(i) ?? null)};
}

/** The list label (list_label); none on a paragraph holding only a page break. */
function listLabel(cx, b, markStyle) {
  const breakOnly = b.clusters.some(c => c.kind === CL.PAGE_BREAK) && b.clusters.every(c => c.kind === CL.PAGE_BREAK || c.kind === CL.MARKER);
  if (!cx.env.label || breakOnly) return null;
  let [text, lvl] = cx.env.label;
  const rc = cx.res(charOverlaid(cx.p.mark ?? {}, lvl.chr ?? {}));
  if (lvl.format === 'bullet' && /[-]/u.test(text) && !/^(Symbol|Wingdings|Webdings)/i.test(rc.font)) text = defaultBullet(cx.rp.numbering?.level ?? 0);
  const shownOf = t => mapText(rc.font, t);
  const cl = shapeLabel(b, text, rc, cx.rp.bidi);
  const runs = [];
  let ascent = 0, x = 0, style = markStyle;
  for (const c of cl) {
    style = c.style;
    const st = b.styles[style];
    if (st) ascent = Math.max(ascent, st.ascent + Math.max(st.shift, 0));
    const chars = [...shownOf(text.slice(c.start, c.end))].map(ch => capsChar(rc, ch)).join('');
    const last = runs[runs.length - 1];
    if (last && last.style === c.style) { last.text += chars; last.shown += c.shown; } else runs.push({style: c.style, x, text: chars, shown: c.shown});
    x += c.adv;
  }
  return {text: shownOf(text), ascent, style, runs, x: 0, width: x};
}

/** Offsets that start a drawing segment inside a whole-paragraph grapheme (joined_cluster_starts). */
function joinedClusterStarts(p, clusters) {
  if (!/[^\x00-\x7f]/.test(p.text)) return [];
  const bounds = new Set(clusterStarts(p.text));
  const out = new Set();
  for (const c of clusters) if (c.start < p.text.length && !bounds.has(c.start)) out.add(c.start);
  return [...out].sort((a, b) => a - b);
}

/** Lay out one paragraph (layout_para). */
export function layoutPara(p, env) {
  const doc = env.doc;
  const rp = paragraphProps(p, env);
  const style = p.props?.style ?? null;
  const tableChr = env.table?.chr ?? null;
  const res = props => doc.resolveChar(style, props, tableChr);
  const levels = bidiLevels(p.text, rp.bidi);
  const b = new Builder(env, levels);
  const cx = {p, env, rp, res, dropFirst: dropCapChar(p, rp)};
  const sh = new Shaped(b, env.eqNumber ?? 0);
  const markRc = res(p.mark ?? {});
  const markStyle = b.style(markRc);
  let s = 0;
  for (const r of p.runs) {
    if (r.len > 0) sh.run(cx, s, s + r.len, r.props ?? {});
    s += r.len;
  }
  if (rp.snapToGrid) snapChars(b.clusters, b.styles, p.text, env.grid);
  const autoSp = rp.snapToGrid && env.grid.chars !== null ? [] : autoSpace(b.clusters, b.styles, b.shown, p.text, rp.autoSpaceDE, rp.autoSpaceDN);
  const bt = breakText(p.text, sh.left.concat(sh.bare));
  const opps = new Set();
  for (const i of breakPositions(bt.text, rp)) { const q = bt.toPara(i); if (q !== null) opps.add(q); }
  for (const c of b.clusters) c.breakAfter = opps.has(c.end) || c.kind === CL.OBJECT || c.kind === CL.TAB;
  const label = listLabel(cx, b, markStyle);
  const joined = joinedClusterStarts(p, b.clusters);
  const pl = new ParaLayout({rp, styles: b.styles, clusters: b.clusters, shown: b.shown, lines: [], label, height: 0, textLen: p.text.length,
    joinedStarts: joined, hasPageFields: sh.hasPageFields, notes: sh.notes, dropCap: sh.dropCap, dropCapW: sh.dropCapW, hyphAfter: [],
    bidiLevels: b.levels, maths: sh.maths, rubies: sh.rubies, displays: sh.displays, ptabs: sh.ptabs, leftOut: [], autoSpace: autoSp, issues: []});
  // Automatic hyphenation (when on for this paragraph): each run's proofing language, so words are hyphenated in their own.
  const auto = !!doc.settings?.autoHyphenation && !rp.suppressHyphens;
  const proofRuns = [];
  if (auto) {
    let runStart = 0;
    for (const r of p.runs) { if (r.len > 0) proofRuns.push({from: runStart, to: runStart + r.len, lang: proofLang(res(r.props ?? {}).lang)}); runStart += r.len; }
  }
  pl.hyphAfter = hyphenationPoints(bt.text, bt.toPara, pl, auto, doc.settings?.hyphenateCaps !== false, proofRuns);
  const markLeftOut = hides(doc, env.hideDeleted, markRc.del) || hidesInserted(env.hideDeleted, markRc.ins) || (markRc.hidden && !env.showHidden);
  const gone = markLeftOut && (p.text.length === 0 || (sh.left[0] && sh.left[0][0] === 0 && sh.left[0][1] === p.text.length));
  pl.leftOut = sh.left;
  keepGraphemesWhole(pl);
  breakLines(pl, env, markStyle, env.label ? env.label[1] : null);
  if (gone) collapse(pl);
  return pl;
}

/** Neither wrapping nor hyphenation splits a drawing group inside a grapheme (keep_graphemes_whole). */
function keepGraphemesWhole(pl) {
  if (pl.joinedStarts.length) {
    for (const c of pl.clusters) if (binHas(pl.joinedStarts, c.end)) c.breakAfter = false;
    pl.hyphAfter = pl.hyphAfter.filter(k => pl.clusters[k] && !binHas(pl.joinedStarts, pl.clusters[k].end));
  }
  for (const k of pl.hyphAfter) if (pl.clusters[k]) pl.clusters[k].breakAfter = true;
}

/** Lay a paragraph out as nothing (collapse). */
function collapse(pl) {
  for (const l of pl.lines) { l.top = 0; l.height = 0; l.baseline = 0; }
  pl.height = 0;
  pl.rp = {...pl.rp, spaceBefore: 0, spaceAfter: 0, shading: null, borders: null};
  pl.label = null;
}

export {SOFT_HYPHEN};
