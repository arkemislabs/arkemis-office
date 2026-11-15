// Text layout for slide text bodies: resolves every run through the placeholder/style chain,
// breaks paragraphs into lines (greedy fill at line-break opportunities, tabs, hanging
// punctuation), places bullets and numbers, applies indents, spacing and alignment, anchors the
// block in the shape's text box, flows columns, and shrinks text on overflow (autofit) by the same
// binary search deckcraft uses. The result is lines of positioned, styled segments in shape-local
// points, plus per-character caret positions for editing.
// Translated from deckcraft crates/text/src/{lib.rs, layout.rs, breaking.rs, style.rs, autonum.rs}
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// No DOM, no Node built-ins.
//
// Shaping: deckcraft shapes runs with its own font stack (rustybuzz); here the caller supplies a
// `measure(font, text) -> width` (Canvas2D measureText in the renderer, host.measureText) and
// optional `metrics(font) -> {ascent, descent}` (font bounding box), per architecture 16.3: line
// breaking and autofit come from this translation, glyph shaping and the visual order of mixed
// right-to-left text inside a line from the browser that draws each line.

import * as resolve from './resolve.mjs';
import {paraText, paraLen, isBreakRun} from './text.mjs';
import {themeFont} from './theme.mjs';
import {TRANSPARENT} from './color.mjs';

/** Line pitch as a multiple of the font size (deckcraft breaking.rs LINE_PITCH). */
export const LINE_PITCH = 1.2;
/** Sub/superscript size factor (deckcraft shape.rs SUB_SUPER). */
export const SUB_SUPER = 2 / 3;

// ---------------------------------------------------------------------------------------------
// autonum.rs

function roman(n, upper) {
  if (n === 0 || n > 3999) return String(n);
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of table) while (n >= v) { s += r; n -= v; }
  return upper ? s.toUpperCase() : s;
}
function alphaNum(n, upper) {
  if (n === 0) return '';
  const i = n - 1;
  const s = String.fromCharCode(97 + (i % 26)).repeat(Math.min(Math.floor(i / 26) + 1, 50));
  return upper ? s.toUpperCase() : s;
}
const letters = (list, n) => (n < 1 ? '' : list[(n - 1) % list.length].repeat(Math.min(Math.floor((n - 1) / list.length) + 1, 50)));
const digitsIn = (n, zero) => [...String(n)].map(d => String.fromCodePoint(zero.codePointAt(0) + Number(d))).join('');
const CJK_DIGITS = [...'〇一二三四五六七八九'];
export function chineseNum(n) {
  if (n === 0 || n > 99999) return String(n);
  const units = ['', '十', '百', '千', '万'];
  const ds = [...String(n)].map(Number);
  let out = '', zero = false;
  ds.forEach((d, i) => {
    const place = ds.length - 1 - i;
    if (d === 0) { zero = true; return; }
    if (zero) { out += '零'; zero = false; }
    if (!(d === 1 && place === 1 && i === 0)) out += CJK_DIGITS[d];
    out += units[place];
  });
  return out;
}
const THAI = [...'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ'];
const HINDI_VOWELS = [...'अआइईउऊऋएऐओऔ'];
const HINDI_CONSONANTS = [...'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह'];
const ARABIC_ALPHABET = [...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'];
const ARABIC_ABJAD = [...'ابجدهوزحطيكلمنسعفصقرشتثخذضظغ'];
const HEBREW = [...'אבגדהוזחטיכלמנסעפצקרשת'];
/** The label for number `n` in auto-numbering scheme `scheme` (`arabicPeriod`, `romanUcParenR`…). */
export function autonum(scheme, n) {
  const circled = (first, count) => String.fromCodePoint(first + (Math.max(n - 1, 0) % count));
  let core;
  if (scheme.startsWith('romanUc')) core = roman(n, true);
  else if (scheme.startsWith('romanLc')) core = roman(n, false);
  else if (scheme.startsWith('alphaUc')) core = alphaNum(n, true);
  else if (scheme.startsWith('alphaLc')) core = alphaNum(n, false);
  else if (scheme.startsWith('circleNumWdWhite')) return circled(0x2460, 10);
  else if (scheme.startsWith('circleNumWdBlack')) return circled(0x2776, 10);
  else if (scheme.startsWith('circleNum')) return String.fromCodePoint(0x2460 + Math.min(Math.max(n - 1, 0), 19));
  else if (scheme.startsWith('ea1Chs') || scheme.startsWith('ea1Cht')) core = chineseNum(n);
  else if (scheme.startsWith('ea1Jpn')) core = [...String(n)].map(d => CJK_DIGITS[Number(d)]).join('');
  else if (scheme.startsWith('arabicDb')) core = digitsIn(n, '０');
  else if (scheme.startsWith('thaiAlpha')) core = letters(THAI, n);
  else if (scheme.startsWith('thaiNum')) core = digitsIn(n, '๐');
  else if (scheme.startsWith('hindiAlpha1')) core = letters(HINDI_CONSONANTS, n);
  else if (scheme.startsWith('hindiAlpha')) core = letters(HINDI_VOWELS, n);
  else if (scheme.startsWith('hindiNum')) core = digitsIn(n, '०');
  else if (scheme.startsWith('arabic1')) core = letters(ARABIC_ALPHABET, n);
  else if (scheme.startsWith('arabic2')) core = letters(ARABIC_ABJAD, n);
  else if (scheme.startsWith('hebrew2')) core = letters(HEBREW, n);
  else core = String(n);
  const wide = scheme.startsWith('ea1') || scheme.startsWith('arabicDb');
  if (scheme.endsWith('ParenBoth')) return `(${core})`;
  if (scheme.endsWith('ParenR')) return `${core})`;
  if (scheme.endsWith('Period')) return `${core}${wide ? '．' : '.'}`;
  if (scheme.endsWith('Minus')) return `${core}-`;
  return core;
}

// ---------------------------------------------------------------------------------------------
// breaking.rs

const isHangul = c => /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/u.test(c);
const isHangingPunct = c => '、。，．､｡'.includes(c);
const isCjNonstarter = c => 'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー々〻ゝゞヽヾ'.includes(c) || /[ㇰ-ㇿｧ-ｰ]/u.test(c);
const isIdeo = c => /[⺀-鿿豈-﫿＀-￯\u{20000}-\u{3134F}]/u.test(c) || isHangul(c);
const CLOSE = new Set([...')]}»”’.,;:!?%…、。，．）】」』〉》〕｝'] );
const OPEN = new Set([...'([{«“‘（【「『〈《〔｛']);
const isSpaceCh = c => c === ' ' || c === '　' || c === ' ' ? c !== ' ' : /\s/u.test(c) && c !== '\u000b' && c !== '\n';

/**
 * Line-break opportunities before each offset 0..=n (deckcraft `break_opportunities`): UAX #14's
 * main classes (spaces, hyphens, ideographs, opening/closing punctuation, mandatory breaks), then
 * deckcraft's corrections (no break inside Hangul words, after ZWSP, before an em dash or a CJK
 * non-starter, or after `/` and `\` unless latinLnBrk).
 */
export function breakOpportunities(text, latinBreak) {
  const chars = [...text];
  const n = chars.length;
  const allowed = Array(n + 1).fill(false), mandatory = Array(n + 1).fill(false);
  for (let i = 1; i <= n; i++) {
    const prev = chars[i - 1], next = chars[i];
    if (prev === '\u000b' || prev === '\n') { allowed[i] = mandatory[i] = true; continue; }
    if (i === n) { allowed[i] = true; continue; }
    if (isSpaceCh(next) || CLOSE.has(next)) continue;
    if (isSpaceCh(prev)) { allowed[i] = true; continue; }
    if (OPEN.has(prev)) continue;
    if (prev === '-' || prev === '‐' || prev === '–' || prev === '­') { allowed[i] = !/\d/.test(next) || prev !== '-'; continue; }
    if (prev === '—' || prev === '​' || prev === '/' || prev === '\\') { allowed[i] = true; continue; }
    if (isIdeo(prev) || isIdeo(next)) { allowed[i] = true; continue; }
  }
  for (let i = 0; i + 1 < n; i++) {
    const prev = chars[i], next = chars[i + 1];
    const keep = (isHangul(prev) && isHangul(next)) || prev === '​' || next === '—' || isCjNonstarter(next)
      ? false : latinBreak || !(prev === '/' || prev === '\\') || /\s/u.test(next);
    if (!keep && !mandatory[i + 1]) allowed[i + 1] = false;
  }
  return {allowed, mandatory};
}

const TAB_ALIGN = {ctr: 'center', r: 'right', dec: 'decimal'};
export const tabsOf = props => (props.tabs ?? []).map(s => ({pos: s.pos, align: TAB_ALIGN[s.align] ?? 'left'}));
function tabSegment(cells, i) {
  let w = 0, dec = null;
  for (const c of cells.slice(i + 1)) {
    if (c.ch === '\t' || c.ch === '\n' || c.ch === '\u000b') break;
    if (c.ch === '.' && dec === null) dec = w;
    w += c.adv;
  }
  return [w, dec ?? w];
}
export function tabAdvance(x, stops, defaultTab, [segW, segDec]) {
  for (const s of stops) {
    if (s.pos > x + 0.5) {
      const to = s.pos - x;
      if (s.align === 'right') return Math.max(to - segW, 0);
      if (s.align === 'center') return Math.max(to - segW / 2, 0);
      if (s.align === 'decimal') return Math.max(to - segDec, 0);
      return to;
    }
  }
  const d = defaultTab > 1 ? defaultTab : 72;
  return Math.max((Math.floor(x / d) + 1) * d - x, 1);
}

/** Greedy line breaking of a shaped paragraph (deckcraft `break_lines`): [{start, end, next}] cell indices. */
export function breakLines(p, {firstW, restW, wrap, tabStops, defaultTab, x0First, x0Rest}) {
  const text = p.cells.map(c => c.ch).join('');
  const {allowed} = breakOpportunities(text, !!p.props.latinLineBreak);
  const hang = !!p.props.hangingPunct;
  const n = p.cells.length;
  const lines = [];
  if (n === 0) return [{start: 0, end: 0, next: 0}];
  let start = 0;
  const breakable = j => j >= n || p.cells[j].boundary;
  while (start < n) {
    const avail = lines.length ? restW : firstW;
    const x0 = lines.length ? x0Rest : x0First;
    let x = 0, lastBreak = null, i = start, end = n, next = n;
    while (i < n) {
      const c = p.cells[i].ch;
      if (c === '\u000b' || c === '\n') { end = i; next = i + 1; break; }
      const adv = c === '\t' ? tabAdvance(x0 + x, tabStops, defaultTab, tabSegment(p.cells, i)) : p.cells[i].adv;
      if (i > start && allowed[i] && breakable(i)) lastBreak = i;
      if (wrap && hang && x + adv > avail + 0.01 && x <= avail + 0.01 && isHangingPunct(c) && i > start) { end = i + 1; next = i + 1; break; }
      if (wrap && c === '\t' && x + adv > avail + 0.01 && i > start) {
        end = i; next = i;
        while (end > start && p.cells[end - 1].ch === ' ') end--;
        break;
      }
      if (wrap && x + adv > avail + 0.01 && !/\s/u.test(c) && i > start) {
        let b = lastBreak !== null && lastBreak > start ? lastBreak : null;
        if (b === null) {
          for (let j = i; j > start; j--) if (breakable(j)) { b = j; break; }
          if (b === null) for (let j = i + 1; j < n; j++) if (breakable(j)) { b = j; break; }
          if (b === null) b = n;
        }
        end = b; next = b;
        while (end > start && p.cells[end - 1].ch === ' ') end--;
        break;
      }
      x += adv;
      i++;
    }
    if (i >= n) { end = n; next = n; }
    lines.push({start, end, next});
    if (next <= start) {
      let to = n;
      for (let j = start + 1; j < n; j++) if (breakable(j)) { to = j; break; }
      lines[lines.length - 1].end = to;
      lines[lines.length - 1].next = to;
      start = to;
    } else start = next;
    if (next === n && p.cells[n - 1].ch === '\u000b' && start >= n) lines.push({start: n, end: n, next: n});
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// style.rs: resolved run styles and shaped paragraphs

/** `spacing_pts`: spacing as points for a paragraph of lead size `size`. */
export const spacingPts = (s, size) => (!s ? 0 : s.kind === 'pct' ? s.v * size * 1.2 : s.kind === 'pts' ? s.v : 0);

const DEFAULT_SPLIT = 0.8;
let segmenter = null;
function graphemes(text) {
  segmenter ??= typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', {granularity: 'grapheme'}) : null;
  if (segmenter) return [...segmenter.segment(text)].map(s => s.segment);
  return [...text];
}

/** A run's drawing style (deckcraft `Style`): font, size, colour, decorations. */
function makeStyle(ctx, rp, scale, fieldsLink) {
  const family = resolve.fontFamily(ctx, rp);
  const size = Math.max((rp.size ?? 18) * scale, 0.5);
  const color = rp.fill?.kind === 'none' ? TRANSPARENT : resolve.textColor(ctx, rp);
  const underline = rp.underline && rp.underline !== 'none' ? rp.underline : null;
  return {
    family, size, bold: !!rp.bold, italic: !!rp.italic, color, baseline: rp.baseline ?? 0, spacing: (rp.spacing ?? 0) * scale,
    caps: rp.caps ?? 'none', underline, underlineColor: rp.underlineColor ? resolve.ctxColor(ctx, rp.underlineColor, null) : null,
    strike: rp.strike && rp.strike !== 'none' ? rp.strike : null, highlight: rp.highlight ? resolve.ctxColor(ctx, rp.highlight, null) : null,
    glow: rp.glow && rp.glow.radius > 0 ? {radius: rp.glow.radius, color: resolve.ctxColor(ctx, rp.glow.color, null)} : null,
    reflection: rp.reflection ? {...rp.reflection} : null,
    link: !!rp.link || !!fieldsLink, ea: rp.fontEa ? themeFont(ctx.master.theme, rp.fontEa) : null, cs: rp.fontCs ? themeFont(ctx.master.theme, rp.fontCs) : null,
  };
}
const fontOf = st => ({family: st.family, size: st.size * (st.baseline ? SUB_SUPER : 1), bold: st.bold, italic: st.italic});

function makeMeasurer(opts) {
  const cache = new Map();
  const measure = opts.measure ?? ((font, t) => t.length * font.size * 0.5);
  const metrics = opts.metrics ?? null;
  return {
    width(st, t) {
      const f = fontOf(st);
      const key = `${f.family}\u0000${f.size}\u0000${f.bold ? 1 : 0}${f.italic ? 1 : 0}\u0000${t}`;
      let w = cache.get(key);
      if (w === undefined) { w = measure(f, t) ?? 0; cache.set(key, w); }
      return w;
    },
    /** (ascent, descent) for a style: LINE_PITCH × size split by the font's ascent ratio. */
    line(st) {
      const h = st.size * LINE_PITCH;
      let split = DEFAULT_SPLIT;
      if (metrics) {
        const key = `m\u0000${st.family}\u0000${st.bold ? 1 : 0}${st.italic ? 1 : 0}`;
        let s = cache.get(key);
        if (s === undefined) {
          const m = metrics({family: st.family, size: 100, bold: st.bold, italic: st.italic});
          s = m && m.ascent > 0 && m.ascent + m.descent > 0 ? m.ascent / (m.ascent + m.descent) : DEFAULT_SPLIT;
          cache.set(key, s);
        }
        split = s;
      }
      return [h * split, h * (1 - split)];
    },
  };
}

/** Shape one paragraph into cells (one per grapheme cluster) with advances and styles. */
function shapePara(ctx, sh, body, pi, scale, opts, number, ms) {
  const para = body.paragraphs[pi];
  const props = resolve.para(ctx, sh, para);
  const styles = [];
  const cells = [];
  const styleOf = rp => { styles.push(makeStyle(ctx, rp, scale)); return styles.length - 1; };
  let off = 0;
  for (const run of para.runs ?? []) {
    const rp = resolve.run(ctx, sh, para, run.props ?? {});
    const si = styleOf(rp);
    const st = styles[si];
    let text = isBreakRun(run) ? '\u000b' : run.kind?.kind === 'field' ? fieldText(run, opts) : run.text ?? '';
    for (const g of graphemes(text)) {
      const shown = st.caps === 'all' || st.caps === 'small' ? g.toUpperCase() : g;
      const smallScale = st.caps === 'small' && g !== g.toUpperCase() ? 0.8 : 1;
      const adv = g === '\u000b' || g === '\n' || g === '\t' ? 0 : ms.width(smallScale === 1 ? st : {...st, size: st.size * smallScale}, shown) + st.spacing;
      cells.push({ch: g[0], text: g, shown, style: si, adv, boundary: true, off, len: g.length, small: smallScale !== 1});
      off += g.length;
    }
  }
  // Lead size: the first run's (or the end mark's) size; empty paragraphs use the end mark.
  const endRp = resolve.run(ctx, sh, para, para.endProps ?? {});
  const endStyle = makeStyle(ctx, endRp, scale);
  const lead = styles[0] ?? endStyle;
  // Bullet (deckcraft style.rs: bullet font, colour and size relative to the first run).
  let bullet = null;
  const b = props.bullet;
  if (b && b.kind !== 'none' && (b.kind === 'char' || b.kind === 'autoNum')) {
    const text = b.kind === 'char' ? b.char : autonum(b.scheme ?? 'arabicPeriod', (b.startAt ?? 1) - 1 + (number ?? 1));
    const bsize = lead.size * (props.bulletSize ?? 1);
    const color = props.bulletColor ? resolve.ctxColor(ctx, props.bulletColor, null) : lead.color;
    const family = b.kind === 'char' && props.bulletFont ? themeFont(ctx.master.theme, props.bulletFont) : lead.family;
    bullet = {text, style: {...lead, family, size: bsize, color, underline: null, strike: null, highlight: null, spacing: 0, baseline: 0}};
  }
  return {cells, styles, props, leadStyle: lead, endStyle, leadSize: lead.size, endSize: endStyle.size, bullet, rtl: !!props.rtl, text: paraText(para), len: paraLen(para)};
}

function fieldText(run, opts) {
  const kind = run.kind.field;
  const v = opts.fields?.(kind);
  return v ?? run.text ?? '';
}

// ---------------------------------------------------------------------------------------------
// layout.rs

function boxGeom(sh, bp, rect) {
  const vert = bp.vert ?? 'horizontal';
  const rotation = (['vertical', 'eaVertical', 'stacked', 'stackedRtl', 'mongolianVertical'].includes(vert) ? 90 : vert === 'vertical270' ? 270 : 0) + (bp.rot ?? 0);
  let r = rect;
  if (Math.abs(rotation - 90) < 1e-6 || Math.abs(rotation - 270) < 1e-6) {
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2, w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    r = {x0: cx - h / 2, y0: cy - w / 2, x1: cx + h / 2, y1: cy + w / 2};
  }
  const il = bp.insetL ?? 7.2, it = bp.insetT ?? 3.6, ir = bp.insetR ?? 7.2, ib = bp.insetB ?? 3.6;
  const inner = {x0: r.x0 + il, y0: r.y0 + it, x1: Math.max(r.x1 - ir, r.x0 + il), y1: Math.max(r.y1 - ib, r.y0 + it)};
  const wrap = bp.wrap !== false && !(bp.autofit?.kind === 'shape' && sh.textBox && bp.wrap === false);
  const ncols = Math.min(Math.max(bp.columns ?? 1, 1), 16);
  const colGap = Math.max(bp.colSpacing ?? 0, 0);
  const colW = Math.max((inner.x1 - inner.x0 - colGap * (ncols - 1)) / ncols, 1);
  const rtlCols = !!bp.rtlCol && ncols > 1;
  return {vert, rotation, inner, wrap, ncols, colGap, colW, rtlCols, colX: c => (rtlCols ? ncols - 1 - c : c) * (colW + colGap),
    linesLtr: vert === 'mongolianVertical' || vert === 'stacked'};
}

/** deckcraft `next_number`: number shown for a paragraph at level `lvl`, advancing counters. */
function nextNumber(numbering, lvl, autoNum, empty) {
  if (autoNum && !empty) {
    numbering[lvl] += 1;
    for (let k = lvl + 1; k < numbering.length; k++) numbering[k] = 0;
    return numbering[lvl];
  }
  if (autoNum) return numbering[lvl] + 1;
  if (!empty) for (let k = lvl; k < numbering.length; k++) numbering[k] = 0;
  return null;
}

/** Where the first line's text starts: past the bullet when there is one. */
function firstLineStart(hasBullet, margin, indent, bulletW) {
  if (!hasBullet) return Math.max(margin + indent, 0);
  const bx = Math.max(margin + indent, 0);
  const stop = Math.max(margin, -indent);
  return indent < 0 && bx + bulletW <= stop ? stop : bx + bulletW + (indent >= 0 ? 0 : 3);
}

function lineExtent(p, rl, ms) {
  let asc = 0, desc = 0, size = 0;
  for (let i = rl.start; i < Math.max(rl.end, rl.start); i++) {
    const st = p.styles[p.cells[i].style];
    const [a, d] = ms.line(st);
    asc = Math.max(asc, a); desc = Math.max(desc, d); size = Math.max(size, st.size);
  }
  if (size === 0) {
    // An empty line is sized by the mark that ends it: the break's run, else the end mark.
    const brk = p.cells[rl.end]?.ch === '\u000b' ? p.styles[p.cells[rl.end].style] : null;
    const st = brk ?? (rl.end >= p.cells.length ? p.endStyle : p.leadStyle);
    const [a, d] = ms.line(st);
    return [a, d, st.size];
  }
  return [asc, desc, size];
}

/** Lay out one pass at font scale `scale` and line reduction `reduce` (deckcraft `layout_scaled`). */
function layoutScaled(ctx, sh, body, bp, opts, scale, reduce, ms) {
  const g = boxGeom(sh, bp, opts.rect);
  const numbering = Array(9).fill(0);
  const paras = (body.paragraphs ?? []).map((para, pi) => {
    const lvl = Math.min(para.level ?? 0, 8);
    const pp = resolve.para(ctx, sh, para);
    const number = nextNumber(numbering, lvl, pp.bullet?.kind === 'autoNum', paraLen(para) === 0);
    return shapePara(ctx, sh, body, pi, scale, opts, number, ms);
  });
  const firstLast = !!bp.spaceFirstLast;
  const flow = {y: 0, prevAfter: 0, tail: 0, lines: []};
  let contentWidth = 0;
  const paraLines = [];
  paras.forEach((p, pi) => {
    const props = p.props;
    const margin = Math.max(props.marginLeft ?? 0, 0);
    const indent = props.indent ?? 0;
    const mr = Math.max(props.marginRight ?? 0, 0);
    const bulletW = p.bullet ? ms.width(p.bullet.style, p.bullet.text) : 0;
    const firstX = firstLineStart(!!p.bullet, margin, indent, bulletW);
    const restX = margin;
    const tabs = tabsOf(props);
    const defaultTab = props.defaultTab ?? 72;
    const raw = breakLines(p, {firstW: Math.max(g.colW - firstX - mr, 1), restW: Math.max(g.colW - restX - mr, 1), wrap: g.wrap, tabStops: tabs, defaultTab,
      x0First: firstX, x0Rest: restX});
    const before = pi === 0 && !firstLast ? 0 : spacingPts(props.spaceBefore, p.leadSize);
    flow.y += Math.max(before, 0) + flow.prevAfter;
    const firstIdx = flow.lines.length;
    raw.forEach((rl, li) => {
      const isLast = li + 1 === raw.length;
      const [asc, desc, size] = lineExtent(p, rl, ms);
      const natural = Math.max(asc + desc, size);
      const ls = props.lineSpacing;
      const lh = ls?.kind === 'pct' ? natural * Math.max(Math.max(ls.v - reduce, ls.v * 0.1), 0) : ls?.kind === 'pts' ? ls.v * (1 - reduce) : natural * (1 - reduce);
      const ratio = natural > 0 ? lh / natural : 1;
      const top = flow.y;
      const exact = ls?.kind === 'pts';
      const baseline = exact ? top + lh * 0.8 : top + asc * ratio;
      flow.tail = exact ? Math.max(lh * 0.2 - desc, -lh) : 0;
      flow.y += lh;
      const x0 = li === 0 ? firstX : restX;
      const avail = Math.max(g.colW - x0 - mr, 0);
      // Advances (tabs from the start edge; a soft-hyphen break shows a hyphen).
      const adv = [];
      let x = 0;
      const shyEnd = !isLast && rl.end > rl.start && p.cells[rl.end - 1].ch === '­';
      for (let k = rl.start; k < rl.end; k++) {
        const c = p.cells[k];
        const a = shyEnd && k === rl.end - 1 ? ms.width(p.styles[c.style], '-') : c.ch === '\t' ? tabAdvance(x0 + x, tabs, defaultTab, tabSegment(p.cells, k)) : c.adv;
        adv.push(a);
        x += a;
      }
      const width = x;
      const align = props.align ?? 'left';
      const slack = Math.max(avail - width, 0);
      const stretch = !isLast && g.wrap && slack > 0;
      let filled = false;
      const cellsOn = p.cells.slice(rl.start, rl.end);
      if (stretch && (align === 'justify' || align === 'justLow')) {
        const spaces = cellsOn.filter(c => c.ch === ' ').length;
        if (spaces > 0) { cellsOn.forEach((c, k) => { if (c.ch === ' ') adv[k] += slack / spaces; }); filled = true; }
      }
      if (align === 'distributed' && adv.length > 1) { for (let k = 0; k < adv.length - 1; k++) adv[k] += slack / (adv.length - 1); filled = true; }
      const lineW = adv.reduce((s, a) => s + a, 0);
      const [boxL, boxR] = p.rtl ? [mr, g.colW - x0] : [x0, g.colW - mr];
      let left;
      if (filled) left = boxL;
      else if (align === 'right') left = boxR - lineW;
      else if (align === 'center') left = boxL + (boxR - boxL - lineW) / 2;
      else if (align === 'distributed' && adv.length <= 1) left = boxL + slack / 2;
      else if (p.rtl) left = boxR - lineW;
      else left = boxL;
      const contentShift = p.rtl ? boxR - (left + lineW) : left - boxL;
      // Caret x at every boundary (logical order; right-to-left lines run from the right edge).
      const caretX = [];
      let vx = p.rtl ? left + lineW : left;
      for (let k = 0; k < adv.length; k++) { caretX.push(vx); vx += p.rtl ? -adv[k] : adv[k]; }
      caretX.push(vx);
      let bullet = null;
      if (li === 0 && p.bullet) {
        const endAligned = p.rtl ? align === 'left' : align === 'right';
        const shifted = align === 'center' || endAligned;
        const bpos = shifted && !p.cells.length ? contentShift + firstX - bulletW : Math.max(margin + indent, 0) + (shifted ? contentShift : 0);
        bullet = {text: p.bullet.text, style: p.bullet.style, x: p.rtl ? g.colW - bpos - bulletW : bpos, width: bulletW};
      }
      flow.lines.push({para: pi, start: rl.start, end: rl.end, top, baseline, bottom: flow.y, left, width: lineW, adv, caretX, column: 0, rtl: p.rtl, bullet,
        startOffset: x0, contentW: width + x0 + mr});
      contentWidth = Math.max(contentWidth, width + x0 + mr);
    });
    paraLines.push([firstIdx, raw.length]);
    flow.prevAfter = Math.max(spacingPts(props.spaceAfter, p.leadSize), 0);
  });
  const total = Math.max(flow.y - flow.tail, 0) + (firstLast ? flow.prevAfter : 0);
  // Columns: distribute lines by height.
  const innerH = g.inner.y1 - g.inner.y0;
  if (g.ncols > 1) {
    let col = 0, colY0 = 0;
    for (const li of flow.lines) {
      if (li.bottom - colY0 > innerH + 0.01 && col + 1 < g.ncols) { col++; colY0 = li.top; }
      li.column = col;
      if (col > 0) { li.top -= colY0; li.baseline -= colY0; li.bottom -= colY0; }
    }
  }
  const usedH = g.ncols > 1 ? flow.lines.reduce((m, l) => Math.max(m, l.bottom), 0) : total;
  const overflow = usedH > innerH + 0.5 || (g.ncols > 1 && (flow.lines[flow.lines.length - 1]?.bottom ?? 0) > innerH + 0.5);
  // Origin from the anchor and anchorCtr.
  const anchor = bp.anchor ?? 'top';
  const dy = anchor === 'middle' ? (innerH - usedH) / 2 : anchor === 'bottom' || anchor === 'justified' || anchor === 'distributed' ? innerH - usedH : 0;
  let ox = g.inner.x0;
  if (bp.anchorCtr && g.ncols === 1 && g.vert === 'horizontal' && flow.lines.length) {
    const ink = flow.lines.filter(l => l.end > l.start);
    const bmin = Math.min(...ink.map(l => l.left)), bmax = Math.max(...ink.map(l => l.left + l.width));
    if (bmax >= bmin) ox = g.inner.x0 + (g.inner.x1 - g.inner.x0) / 2 - (bmin + bmax) / 2;
  }
  const oy = g.inner.y0 + dy;
  const lines = flow.lines.map(l => {
    const cx = ox + g.colX(l.column);
    const out = {...l, top: l.top + oy, baseline: l.baseline + oy, bottom: l.bottom + oy, left: l.left + cx, caretX: l.caretX.map(v => v + cx),
      bullet: l.bullet ? {...l.bullet, x: l.bullet.x + cx, baseline: l.baseline + oy} : null};
    if (g.linesLtr) {
      const d = g.inner.y0 + g.inner.y1 - out.top - out.bottom;
      out.top += d; out.baseline += d; out.bottom += d;
    }
    // Segments of consecutive cells in one style, with their x (for HTML spans).
    const p = paras[l.para];
    out.segments = [];
    let seg = null;
    let xx = out.left;
    for (let k = l.start; k < l.end; k++) {
      const c = p.cells[k];
      const a = l.adv[k - l.start];
      const key = `${c.style}${c.small ? 's' : ''}`;
      if (!seg || seg.key !== key || c.ch === '\t') {
        seg = {key, style: p.styles[c.style], small: c.small, text: '', x: xx, width: 0, from: c.off, to: c.off};
        out.segments.push(seg);
      }
      seg.text += c.ch === '\t' ? '' : c.shown;
      seg.width += a;
      seg.to = c.off + c.len;
      xx += a;
      if (c.ch === '\t') seg = null;
    }
    // Paragraph offsets of each boundary on the line (cells may be several code units).
    out.offsets = [];
    for (let k = l.start; k < l.end; k++) out.offsets.push(p.cells[k].off);
    out.offsets.push(l.end < p.cells.length ? p.cells[l.end].off : p.len);
    out.offsetStart = out.offsets[0] ?? 0;
    out.offsetEnd = out.offsets[out.offsets.length - 1] ?? 0;
    delete out.adv;
    return out;
  });
  return {lines, inner: g.inner, contentHeight: total, contentWidth, fontScale: scale, lineReduction: reduce, overflow, rotation: g.rotation, paraLines,
    vert: g.vert, paragraphs: paras.map(p => ({rtl: p.rtl, len: p.len, endStyle: p.endStyle, leadStyle: p.leadStyle}))};
}

/**
 * Lay out a shape's text body (deckcraft `layout`). `opts.rect` is the text box (the preset's text
 * rectangle in shape-local points); `opts.measure(font, text)`, `opts.metrics(font)` measure text;
 * `opts.noShrink` ignores autofit; `opts.fields(kind)` supplies field values.
 */
export function layoutText(ctx, sh, body, opts) {
  const ms = makeMeasurer(opts);
  const bp = resolve.body(ctx, sh);
  const autofit = bp.autofit ?? {kind: 'none'};
  const shrink = autofit.kind === 'shrink' && !opts.noShrink;
  const scale0 = shrink ? (Number.isFinite(autofit.fontScale) ? Math.min(Math.max(autofit.fontScale, 0.1), 1) : 1) : 1;
  const reduce0 = shrink ? (Number.isFinite(autofit.lineReduction) ? Math.min(Math.max(autofit.lineReduction, 0), 0.2) : 0) : 0;
  const noSavedScale = shrink && autofit.fontScale == null;
  let l = layoutScaled(ctx, sh, body, bp, opts, scale0, reduce0, ms);
  // A saved scale is drawn as it is; PowerPoint fits again only when the text changes
  // (`opts.refit` asks for that: the text was just edited).
  const saved = !opts.refit && (noSavedScale || scale0 < 1 || reduce0 > 0);
  if (shrink && l.overflow && !saved) {
    const smallest = layoutScaled(ctx, sh, body, bp, opts, 0.1, 0.2, ms);
    if (smallest.overflow) return smallest;
    let lo = 0.1, hi = opts.refit ? 1 : scale0, best = smallest;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const red = Math.max(Math.min((1 - mid) * 0.8, 0.2), opts.refit ? 0 : reduce0);
      const t = layoutScaled(ctx, sh, body, bp, opts, mid, red, ms);
      if (t.overflow) hi = mid; else { lo = mid; best = t; }
    }
    l = best;
  }
  return l;
}

/** The line holding paragraph offset `off` of paragraph `pi` (the last line it ends on). */
export function lineAt(layout, pi, off) {
  let found = null;
  for (const l of layout.lines) if (l.para === pi && off >= l.offsetStart && off <= l.offsetEnd) found = found && off === found.offsetEnd ? found : l;
  return found ?? layout.lines.filter(l => l.para === pi).pop() ?? null;
}

/** Caret x for paragraph offset `off` on line `l`. */
export function caretX(l, off) {
  const k = l.offsets.findIndex(o => o >= off);
  return k < 0 ? l.caretX[l.caretX.length - 1] : l.caretX[k];
}

/** The [paragraph, offset] nearest shape-local point (x, y) (deckcraft `text_pos_at`). */
export function hitText(layout, x, y) {
  if (!layout.lines.length) return [0, 0];
  let best = layout.lines[0];
  for (const l of layout.lines) {
    if (y >= l.top && y < l.bottom) { best = l; break; }
    if (y >= l.bottom) best = l;
  }
  let bi = 0, bd = Infinity;
  best.caretX.forEach((cx, k) => { const d = Math.abs(cx - x); if (d < bd) { bd = d; bi = k; } });
  return [best.para, best.offsets[bi] ?? 0];
}
