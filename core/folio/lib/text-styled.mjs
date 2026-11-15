// The styled rewrite: a paragraph of several fonts, sizes or colours keeps the style of each run when its words are edited.
//
// Translated from printcraft at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/text/blocks.rs                 TextBlock::edited_spans (the words of the old and new text aligned with Myers' shortest edit script, so
//                                                  words left untouched keep their runs, and inserted characters inherit the run before the change),
//                                                  words, edit_script, backtrack, replaced
//   crates/edit/src/text_regions/styled.rs         rewrite_styled_block: rows wrapped by each character's own advance, each surviving character written in
//                                                  its source font (a face that lacks it is replaced by the run's standard family), size and colour
// Not translated (docs/spec/patches/folio/edit.json): per-range formatting of a selection (BlockStyle.ranges), shaping for Arabic, Hebrew, Thai and the
// Japanese fallback, the /P marker bookkeeping around a rewritten region, justification (refused upstream as well), and a paragraph whose runs are turned
// or drawn at different scales (those are set in the first run's style). Names kept: this is not checked against styled.rs beyond what is listed.
// No DOM, no Node built-ins.

import {mul} from './redact-content.mjs';
import {mk, paintOps, stateOps, TextError} from './text-interp.mjs';
import {Metrics, fontDictOf, sourceFamily, familyBaseFont, stdTextWidth} from './text-font.mjs';
import {firstUndrawable, winAnsiBytes} from './fonts.mjs';
import {freeFontName, cropOf} from './edit-place.mjs';
import {paragraphText, drawnMovement, emitTextMatrix, lineLead, showsBeforeParagraph, revealOps, sourceShow, standInDict, setFonts, writeStreams, refuseClippingText, paragraphWidth} from './text-rewrite.mjs';
import {isCentred} from './text-blocks.mjs';

const invalid = message => new TextError(message);
const NL = String.fromCharCode(10);

// ── edited_spans ───────────────────────────────────────────────────────────────────────────────

const MAX_CHANGED_WORDS = 64;

/** words: `text` split into words, each with the white space after it, as ranges. */
function wordsOf(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i + 1 < text.length; i++) if (/\s/.test(text[i]) && !/\s/.test(text[i + 1])) { out.push([start, i + 1]); start = i + 1; }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

/** Myers' shortest edit script from `a` to `b` (arrays of strings), or null when it takes more than `max` steps. */
function editScript(a, b, max) {
  const [n, m] = [a.length, b.length];
  max = Math.min(max, n + m);
  const at = (v, k) => v[k + max + 1] ?? 0;
  let v = new Array(2 * max + 3).fill(0);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(v, k - 1) < at(v, k + 1));
      let x = down ? at(v, k + 1) : at(v, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + max + 1] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, max);
    }
  }
  return null;
}
function backtrack(trace, n, m, max) {
  const at = (v, k) => v[k + max + 1] ?? 0;
  const steps = [];
  let [x, y] = [n, m];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(v, k - 1) < at(v, k + 1)) ? k + 1 : k - 1;
    const prevX = at(v, prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { steps.push('keep'); x--; y--; }
    if (d > 0) steps.push(x === prevX ? 'insert' : 'delete');
    [x, y] = [prevX, prevY];
  }
  return steps.reverse();
}

/** replaced: `old`, at char `at` of the source, became `neu`: characters kept at either end keep their runs, the rest inherit the run before the change. */
function replaced(original, at, old, neu, out) {
  let prefix = 0;
  while (prefix < old.length && prefix < neu.length && old[prefix] === neu[prefix]) prefix++;
  let suffix = 0;
  const room = Math.min(old.length, neu.length) - prefix;
  while (suffix < room && old[old.length - 1 - suffix] === neu[neu.length - 1 - suffix]) suffix++;
  const start = at + prefix;
  const inherited = (start > 0 ? original[start - 1] : undefined) ?? original[start] ?? 0;
  for (let i = 0; i < neu.length; i++) {
    let source;
    if (i < prefix) source = original[at + i];
    else if (i >= neu.length - suffix) source = original[at + old.length - (neu.length - i)];
    else source = inherited;
    out.push(source ?? inherited);
  }
}

/** edited_spans, as one source line per character of `draft`. */
export function sourcesFor(block, draft) {
  const old = block.editorText.split('');
  const neu = draft.split('');
  const original = new Array(old.length);
  let span = 0;
  for (let i = 0; i < old.length; i++) {
    while (block.spans[span] && i >= block.spans[span][1]) span++;
    original[i] = (block.spans[span] ?? block.spans.at(-1))[2];
  }
  const slices = text => wordsOf(text.join('')).map(([a, b]) => text.slice(a, b).join(''));
  const [oldWords, newWords] = [slices(old), slices(neu)];
  const sources = [];
  const script = editScript(oldWords, newWords, MAX_CHANGED_WORDS);
  if (!script) replaced(original, 0, old, neu, sources);
  else {
    let [o, n, x, y] = [0, 0, 0, 0];
    let [a, b] = [0, 0];
    for (const step of script) {
      if (step === 'keep') {
        replaced(original, o, old.slice(o, x), neu.slice(n, y), sources);
        const len = oldWords[a++].length;
        b++;
        for (let k = 0; k < len; k++) sources.push(original[x + k]);
        x += len; y += len;
        [o, n] = [x, y];
      } else if (step === 'delete') x += oldWords[a++].length;
      else y += newWords[b++].length;
    }
    replaced(original, o, old.slice(o, x), neu.slice(n, y), sources);
  }
  return sources;
}

// ── the rewrite ────────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite a paragraph of several styles. Returns null when its runs can't share one layout (turned, or drawn at different scales): the caller then sets
 * it in the first run's style.
 */
export function rewriteStyled({doc, page, read, lines, b, members, first, style, text, dropped, resources, fontsRes}) {
  const {ops} = read;
  const o = first.origin, last = members.at(-1), emit = last.origin;
  const k = Math.max(o.k, 1e-6);
  if (members.some(l => !l.origin.state.font || Math.abs(l.origin.k - o.k) > 1e-6)) return null;
  const draft = paragraphText(text ?? b.reflowText);
  if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(draft)) throw invalid("right-to-left text isn't written here yet");
  const sources = sourcesFor(b, draft);
  const chars = draft.split('');
  // Each source line's style, once.
  const infos = new Map();
  const infoOf = li => {
    if (!infos.has(li)) {
      const l = lines[li];
      const [name, tsize] = l.origin.state.font;
      const dict = fontDictOf(doc.context, resources, name);
      let metrics = null;
      try { metrics = dict ? Metrics.fromDict(doc.context, dict) : null; } catch { metrics = null; }
      const size = style.size !== undefined ? Math.max(style.size / k, 0.1) : tsize;
      infos.set(li, {name, size, metrics, family: sourceFamily(l.baseFont), bold: l.bold, italic: l.italic, fill: style.color ? [mk.op('rg', ...style.color.map(mk.num))] : l.origin.state.fill,
        charSpacing: style.charSpacing !== undefined ? style.charSpacing / k : l.origin.state.charSpacing, scale: style.scale !== undefined ? Math.min(10, Math.max(0.1, style.scale / 100)) : l.origin.state.scale,
        baseFont: l.baseFont});
    }
    return infos.get(li);
  };
  const addFonts = new Map();
  let substituted = null;
  const standIn = inf => {
    const base = familyBaseFont(inf.family, inf.bold, inf.italic);
    if (!addFonts.has(base)) {
      const name = freeFontName(doc, fontsRes ?? doc.context.obj({}), `PCEd${base.replace(/-/g, '')}`, base);
      addFonts.set(base, name);
    }
    return {base, name: addFonts.get(base)};
  };
  // Per character: shown by its source font, or by a standard face when that font lacks it.
  const glyph = i => {
    const c = chars[i], inf = infoOf(sources[i] ?? sources[0] ?? b.lines[0]);
    const src = inf.metrics && (c === ' ' || inf.metrics.encode(c) !== null);
    if (src) return {src: true, inf, width: (inf.metrics.textWidth(c, inf.size, inf.metrics.space(), 0, 0) + inf.charSpacing) * inf.scale * k};


    if (c !== NL && firstUndrawable(c) !== null) throw invalid(`"${c}" is a character neither ${inf.baseFont || 'the font'} nor the standard fonts can show`);
    const base = familyBaseFont(inf.family, inf.bold, inf.italic);
    return {src: false, inf, base, width: (stdTextWidth(base, c, inf.size) + inf.charSpacing) * inf.scale * k};
  };
  const glyphs = chars.map((c, i) => (c === NL ? {src: true, inf: infoOf(sources[i] ?? sources[0]), width: 0, nl: true} : glyph(i)));
  for (const g of glyphs) if (!g.src && !g.nl) substituted = familyBaseFont(g.inf.family, g.inf.bold, g.inf.italic);

  // Geometry, as the single-style path has it.
  const [dx, dy] = style.offset ?? [0, 0];
  if (!(Number.isFinite(dx) && Number.isFinite(dy))) throw invalid("the paragraph can't be moved that far");
  const crop = cropOf(page);
  const firstInf = infoOf(b.lines[0]);
  const centred = style.width === undefined && style.align === undefined && isCentred(b, lines, (crop[0] + crop[2]) / 2, first.size);
  const width = paragraphWidth({rect: b.rect, frame: b.rect, crop, upright: true, k, size: firstInf.size, dx, singleLine: members.length === 1, centred}, style.width);
  const align = centred ? 'center' : style.align;
  const movement = drawnMovement(emit.ctm, dx, dy);
  const tm = emitTextMatrix(o, emit);

  // Wrapping by the characters' own widths (blocks.rs wrap): a row is a range of the draft; only the spaces where a row wraps are dropped.
  const rows = [];
  {
    const limit = width + 0.5;
    const sum = (x, y) => { let t = 0; for (let q = x; q < y; q++) t += glyphs[q].width; return t; };
    for (let p = 0; ;) {
      let e = p;
      while (e < chars.length && chars[e] !== NL) e++;
      let [lineA, lineW, lineEnd, soft, wrapGap, hasWord, i] = [p, 0, p, false, 0, false, p];
      while (i < e) {
        const gs = i;
        while (i < e && chars[i] === ' ') i++;
        if (i >= e) break;
        const ws = i;
        while (i < e && chars[i] !== ' ') i++;
        const [gw, ww] = [sum(gs, ws), sum(ws, i)];
        if (hasWord && lineW + gw + ww > limit) {
          rows.push({a: lineA, b: lineEnd, soft, gap: wrapGap});
          [soft, wrapGap, lineA, lineW] = [true, ws - gs, ws, ww];
        } else lineW += gw + ww;
        hasWord = true;
        lineEnd = i;
      }
      rows.push({a: lineA, b: e, soft, gap: wrapGap});
      if (e >= chars.length) break;
      p = e + 1;
    }
  }
  const lead = lineLead(b, lines, style, {k, size: firstInf.size, oldSize: firstInf.size, leading: o.state.leading});
  const startOp = last.ops[0] ?? emit.btOp;
  const split = showsBeforeParagraph(ops, emit.btOp, startOp, dropped);
  const after = split ? emit.state : emit.btState;
  const n = mk.num;
  const out = [mk.op('q'), ...revealOps(b, lines, style, emit.ctm)];
  if (movement) out.push(mk.op('cm', n(1), n(0), n(0), n(1), n(movement[0]), n(movement[1])));
  const state = {...o.state, wordSpacing: 0, fill: firstInf.fill, charSpacing: firstInf.charSpacing, scale: firstInf.scale, font: null};
  out.push(...paintOps(o.state, after), mk.op('BT'));
  out.push(...stateOps(state).filter(op => op.op !== 'Tf'), mk.op('Tm', ...tm.map(n)));
  const cur = {font: null, size: null, fill: JSON.stringify(firstInf.fill), tc: firstInf.charSpacing, tz: firstInf.scale};
  const setFont = (name, size) => { if (cur.font !== name || cur.size !== size) { out.push(mk.op('Tf', mk.name(name), n(size))); cur.font = name; cur.size = size; } };
  let cursorX = 0;
  rows.forEach((row, index) => {
    let e = row.b;
    while (e > row.a && chars[e - 1] === ' ') e--;
    let visible = 0;
    for (let i = row.a; i < e; i++) visible += glyphs[i].width;
    const free = Math.max(width - visible, 0) / k;
    const dxl = align === 'center' ? free / 2 : align === 'right' ? free : 0;
    if (index > 0) {
      if (row.soft) out.push(mk.op('BDC', mk.name('PCSoft'), mk.dict([['N', n(row.gap)]])));
      else out.push(mk.op('BMC', mk.name('PCHard')));
      out.push(mk.op('EMC'));
    }
    if (index > 0 || dxl !== 0) out.push(mk.op('Td', n(dxl - cursorX), n(index > 0 ? -lead : 0)));
    cursorX = dxl;
    // Runs of one style and kind.
    for (let i = row.a; i < row.b;) {
      const g = glyphs[i];
      let j = i + 1;
      while (j < row.b && glyphs[j].inf === g.inf && glyphs[j].src === g.src && (g.src || glyphs[j].base === g.base)) j++;
      const run = chars.slice(i, j).join('');
      const inf = g.inf;
      const fillKey = JSON.stringify(inf.fill);
      if (fillKey !== cur.fill) { out.push(...inf.fill); cur.fill = fillKey; }
      if (inf.charSpacing !== cur.tc) { out.push(mk.op('Tc', n(inf.charSpacing))); cur.tc = inf.charSpacing; }
      if (inf.scale !== cur.tz) { out.push(mk.op('Tz', n(inf.scale * 100))); cur.tz = inf.scale; }
      if (g.src) {
        setFont(inf.name, inf.size);
        out.push(...sourceShow(inf.metrics, run, inf.size, inf.metrics.space(), inf.charSpacing, 0));
      } else {
        setFont(standIn(inf).name, inf.size);
        out.push(mk.op('Tj', mk.str(Uint8Array.from(winAnsiBytes(run)))));
      }
      i = j;
    }
  });
  out.push(mk.op('ET'), mk.op('Q'));
  out.push(...stateOps(after).filter(op => op.op !== 'Tf' || after.font));
  if (split) { out.unshift(mk.op('ET')); out.push(mk.op('BT'), mk.op('Tm', ...emit.tlm.map(n))); }
  const used = writeStreams(doc, page, read, dropped, new Map([[split ? startOp : emit.btOp, out]]));
  const add = [...addFonts.entries()].map(([base, name]) => [name, standInDict(base)]);
  if (add.length || [...(fontsRes?.keys() ?? [])].some(key => key.decodeText().startsWith('PCEd'))) {
    for (const [name] of add) used.add(name);
    setFonts(doc, page, add, name => used.has(name));
  }
  return {substituted, flattened: false, styled: true, rows: rows.length};
}
