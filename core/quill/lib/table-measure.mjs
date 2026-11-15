// AutoFit to Contents: what each grid column of a table needs (its longest word and its longest
// line, cell margins included) and how Word shares the room between the columns.
//
// Translated from wordcraft crates/layout/src/table.rs (`measure_para`, `measure_table_columns`,
// `autofit_widths`, `region_of`, `region_text`, `row_gaps`, MEASURE_BUDGET / MEASURE_WIDE /
// EMPTY_TEXT) at ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c; the layout foundation
// (core/quill/layout) left these out, and `table.autofit {mode:'contents'}` needs them.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {LDoc} from '../layout/ldoc.mjs';
import {Ctx} from '../layout/ctx.mjs';
import {LayoutCache} from '../layout/cache.mjs';
import {getDefaultShaper} from '../layout/shaper.mjs';
import {layoutPara} from '../layout/para/paragraph.mjs';
import {CL} from '../layout/para/model.mjs';
import {cellResolvedMargins, charOverlaid, tableLook} from '../model/props.mjs';
import {partsOfCell, tableStyle, tableStylePart} from '../model/styles.mjs';
import {MAX_COLS, cellSpan, rowFirstGrid, rowGridAfter, tableCols} from '../model/table.mjs';

const MEASURE_BUDGET = 4000;
const MEASURE_WIDE = 15_840;
const EMPTY_TEXT = 12;
const DEFAULT_MARGINS = [0, 5.4, 0, 5.4];

/** The longest run without a break opportunity and the longest unwrapped line, indents included (measure_para). */
function measurePara(p, env) {
  const pl = layoutPara(p, env);
  const rp = pl.rp;
  const indents = Math.max(0, rp.indentLeft ?? 0) + Math.max(0, rp.indentRight ?? 0) + Math.max(0, rp.indentFirst ?? 0);
  let word = 0, min = 0;
  for (const c of pl.clusters) {
    if (c.kind === CL.TEXT || c.kind === CL.OBJECT) word += Math.max(0, c.adv);
    else if (c.kind !== CL.MARKER) { min = Math.max(min, word); word = 0; }
    if (c.breakAfter) { min = Math.max(min, word); word = 0; }
  }
  min = Math.max(min, word);
  let max = 0;
  for (const l of pl.lines) {
    let lo = Infinity, hi = -Infinity;
    for (let k = l.c0; k < l.c1; k++) {
      const c = pl.clusters[k], a = l.clLeft(k), b = l.clRight(k);
      if (!c || a === null || b === null) continue;
      lo = Math.min(lo, a, b);
      if (![CL.SPACE, CL.MARKER, CL.LINE_BREAK, CL.PAGE_BREAK, CL.COLUMN_BREAK].includes(c.kind)) hi = Math.max(hi, a, b);
    }
    if (hi > lo) max = Math.max(max, hi - lo + (l.hyphen ? l.hyphen.adv ?? l.hyphen[2] ?? 0 : 0));
  }
  min = Number.isFinite(min) ? min : 0;
  max = Number.isFinite(max) ? Math.max(max, min) : min;
  return [min + indents, max + indents];
}

/** The table style's text formatting in a region (region_text). */
function regionText(style, parts) {
  let chr = {};
  const para = {...(style.para ?? {})};
  for (const part of parts) {
    const f = tableStylePart(style, part);
    chr = charOverlaid(chr, f.chr ?? {});
    if (f.align) para.align = f.align;
  }
  return {para, chr};
}

/** Row gaps (`w:gridBefore` / `w:gridAfter` with their widths) as spans (row_gaps). */
function rowGaps(row, end) {
  const p = row.props ?? {};
  return [[0, rowFirstGrid(row), p.wBefore], [end, rowGridAfter(row), p.wAfter]]
    .filter(([, n, w]) => n > 0 && Number.isFinite(w) && w > 0).map(([g, n, w]) => [g, n, Math.min(w, 1584)]);
}

/**
 * What each grid column of `t` needs for AutoFit to Contents, [narrowest, widest] in points with
 * cell margins included (measure_table_columns). `content` is the document's schema-2 content.
 */
export function measureTableColumns(content, t, shaper = getDefaultShaper()) {
  const ldoc = new LDoc(content);
  const cx = new Ctx(ldoc, new LayoutCache(), {view: 'print'}, shaper);
  const style = t.props?.style ? tableStyle(content.styles, t.props.style) : null;
  const marginsDef = t.props?.cellMargins ?? style?.parts?.cellMargins ?? DEFAULT_MARGINS;
  const ncols = Math.max(1, Math.min(tableCols(t), MAX_COLS));
  const cols = Array.from({length: ncols}, () => [0, 0]);
  const spanned = [];
  let budget = MEASURE_BUDGET;
  const look = tableLook(t.props ?? {});
  const bands = [style?.parts?.bandSize ?? 0, style?.parts?.colBandSize ?? 0];
  rows: for (let ri = 0; ri < t.rows.length; ri++) {
    const row = t.rows[ri];
    let g = rowFirstGrid(row);
    for (const cell of row.cells) {
      const span = cellSpan(cell);
      const m = cellResolvedMargins(cell.props ?? {}, marginsDef);
      const side = Math.max(0, m[1]) + Math.max(0, m[3]);
      const text = style ? regionText(style, partsOfCell(look, bands, [ri, t.rows.length], [g, span, ncols])) : null;
      const env = {...cx.paraEnv(MEASURE_WIDE, null, text, []), showHidden: false, fieldCodes: false, numeral: 'arabic'};
      let min = EMPTY_TEXT, max = EMPTY_TEXT;
      const turned = ['down', 'up'].includes(cell.props?.textDirection);
      if ((cell.props?.vmerge ?? 'none') !== 'continue' && !turned) {
        for (const b of cell.blocks) {
          if (b.kind === 'para') {
            if (budget === 0) break rows;
            budget--;
            const [a, z] = measurePara(b, env);
            min = Math.max(min, a);
            max = Math.max(max, z);
          } else {
            const w = (b.grid ?? []).filter(Number.isFinite).reduce((s, x) => s + Math.max(0, Math.min(1584, x)), 0);
            min = Math.max(min, w);
            max = Math.max(max, w);
          }
        }
      }
      min = Math.min(min + side, 1584);
      max = Math.min(max + side, 1584);
      if (span === 1) {
        if (cols[g]) { cols[g][0] = Math.max(cols[g][0], min); cols[g][1] = Math.max(cols[g][1], max); }
      } else spanned.push([g, span, min, max]);
      g += span;
    }
    for (const [gg, n, w] of rowGaps(row, g)) spanned.push([gg, n, w, w]);
  }
  for (const [g, span, min, max] of spanned) {
    const cs = cols.slice(g, Math.min(g + span, ncols));
    if (!cs.length) continue;
    const n = cs.length;
    const haveMin = cs.reduce((s, c) => s + c[0], 0), haveMax = cs.reduce((s, c) => s + c[1], 0);
    for (const c of cs) {
      c[0] += Math.max(0, (min - haveMin) / n);
      c[1] += Math.max(0, (max - haveMax) / n);
      c[1] = Math.max(c[1], c[0]);
    }
  }
  const floor = Math.max(0, marginsDef[1]) + Math.max(0, marginsDef[3]) + EMPTY_TEXT;
  for (const c of cols) { c[0] = Math.max(c[0], floor); c[1] = Math.max(c[1], c[0]); }
  return cols;
}

/** Column widths for AutoFit to Contents, the way Word shares the room (autofit_widths). */
export function autofitWidths(cols, avail) {
  const clean = v => (Number.isFinite(v) ? Math.max(0, Math.min(1584, v)) : 0);
  const cs = cols.map(([a, b]) => [clean(a), Math.max(clean(b), clean(a))]);
  const room = clean(avail);
  const sumMin = cs.reduce((s, c) => s + c[0], 0), sumMax = cs.reduce((s, c) => s + c[1], 0);
  if (sumMax <= room) return cs.map(c => c[1]);
  if (sumMin >= room || sumMax <= sumMin) return cs.map(c => c[0]);
  const k = (room - sumMin) / (sumMax - sumMin);
  return cs.map(c => c[0] + (c[1] - c[0]) * k);
}
