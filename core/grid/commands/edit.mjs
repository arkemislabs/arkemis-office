// Home › Editing › Clear (All, Formats, Contents, Comments and Notes, Hyperlinks; Delete) and
// Home › Clipboard › Format Painter for Grid.
// Translated from gridcraft crates/engine/src/cmd/edit.rs (`clear`, `format_painter`, specs) and
// crates/ui-egui/src/ribbon/home.rs (the Format Painter toggle: a click while it is on turns it
// off, a double-click keeps it on) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Delete works on checkboxes in two passes, as in Excel: checked boxes are unchecked first, and
// only when every box in the selection is unchecked are the boxes removed. Excel's Remove
// Hyperlinks (`formats: true`) also takes the link formatting off. The other edit commands live in
// commands/edit/*.mjs (cell entry, clipboard, fill, find, go to, selection).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {intersection, union, count, isFullCols, isFullRows, rangeA1, parseRange, contains, offsetClamped, height, width} from '../lib/addr.mjs';
import {cellAt, forEachCell, writeCell, usedBounds} from '../model/store.mjs';
import {resolveStyle, styleById, deriveStyle, internStyle} from '../model/style.mjs';
import {styleIdAt} from '../model/workbook.mjs';
import {keysIn, removeMerges, setIn} from '../lib/edit-parts.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, failed, bad, requireSchema2, setGridSelection, rangeSelection, areaAddress, parseAreas, splitRef, baseDoc} from '../lib/edit-targets.mjs';
import {guardWrite} from './edit/cell.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/ui-egui/src/ribbon/home.rs']};

const RANGE = s.optional(s.string({min: 1, max: 100_000, description: 'Range: /sh:<id>/A1:C9, Sheet1!A1:C9 or A1:C9 (default: the selection)'}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const SIDE = ['notes', 'comments', 'hyperlinks'];

/** The used range for clearing: stored cells and the notes, comments and links beside them. */
function usedForClear(sheet) {
  const b = usedBounds(sheet);
  let u = b ? {start: {row: b.r0, col: b.c0}, end: {row: b.r1, col: b.c1}} : null;
  for (const map of SIDE) for (const k of Object.keys(sheet[map] ?? {})) {
    const c = parseRange(k)?.start;
    if (c) u = u ? union(u, {start: c, end: c}) : {start: {...c}, end: {...c}};
  }
  return u;
}

const numFmtOf = (ctx, id) => resolveStyle(styleById({styles: ctx.change.get(['styles']) ?? ctx.doc.styles}, id)).numFmt;

/** edit.rs `clear`. */
function clear(ctx, p, what) {
  baseDoc(ctx);
  const {sheet: si, areas} = targetRanges(ctx, p);
  requireSchema2(ctx, si);
  const sheet0 = ctx.doc.sheets[si];
  const used = usedForClear(sheet0);
  // Delete on checkboxes: uncheck first when any box in the selection is checked.
  let uncheckOnly = false;
  if (what === 'contents' && used) {
    for (const r of areas) {
      const x = intersection(r, used);
      if (!x) continue;
      forEachCell(sheet0, x.start.row, x.start.col, x.end.row, x.end.col, (row, col, cell) => {
        if (cell.v === true && cell.f === undefined && numFmtOf(ctx, cell.s) === 'checkbox') { uncheckOnly = true; return false; }
        return true;
      });
      if (uncheckOnly) break;
    }
  }
  let n = 0;
  for (const r0 of areas) {
    if (!used) break;
    const r = intersection(r0, used);
    if (!r) continue;
    const cells = [];
    forEachCell(ctx.doc.sheets[si], r.start.row, r.start.col, r.end.row, r.end.col, (row, col, cell) => { cells.push([row, col, cell]); });
    for (const [row, col, cell] of cells) {
      let next = null;
      if (what === 'all') next = null;
      else if (what === 'contents') {
        const checkbox = numFmtOf(ctx, cell.s) === 'checkbox';
        next = {...cell};
        delete next.f; delete next.a; delete next.d;
        if (checkbox && uncheckOnly) next.v = false;
        else {
          delete next.v;
          if (checkbox) next.s = deriveStyle(ctx.change, ctx.doc, cell.s, {numFmt: 'General'});
        }
      } else if (what === 'formats') {
        next = {...cell};
        delete next.s;
      } else continue;
      if (what !== 'formats') guardWrite(ctx, si, row, col, next);
      writeCell(ctx.change, ctx.doc, si, row, col, next);
      n++;
    }
    if (what === 'all' || what === 'comments') for (const map of ['notes', 'comments']) for (const k of keysIn(ctx.doc.sheets[si][map], r)) ctx.change.delete(['sheets', si, map, k]);
    if (what === 'all' || what === 'hyperlinks') {
      for (const k of keysIn(ctx.doc.sheets[si].hyperlinks, r)) {
        ctx.change.delete(['sheets', si, 'hyperlinks', k]);
        if (what === 'hyperlinks' && p.formats) {
          // Excel's Remove Hyperlinks: the link's formatting goes with it.
          const c = parseRange(k).start;
          const cell = cellAt(ctx.doc.sheets[si], c.row, c.col);
          if (cell?.s) { const nc = {...cell}; delete nc.s; writeCell(ctx.change, ctx.doc, si, c.row, c.col, nc); }
        }
      }
    }
    if (what === 'all' || what === 'formats') removeMerges(ctx.change, ctx.doc, si, r);
  }
  return {cleared: n, ranges: areas.map(r => areaAddress(ctx.doc, si, r))};
}

// ---------------------------------------------------------------------------------------------
// Format Painter (edit.rs `format_painter`)

/** The picked-up format (view state); `source` (the workbook then) is never serialized. */
export const painterOf = ctx => ctx.view?.formatPainter ?? null;

function pickUp(ctx, sticky) {
  const sel = gridSel(ctx);
  const sheet = ctx.doc.sheets[sel.sheet];
  const fp = {sheetId: sheet.id, range: rangeA1(sel.ranges[sel.ranges.length - 1]), sticky: !!sticky};
  Object.defineProperty(fp, 'source', {value: ctx.doc, enumerable: false});
  ctx.setView({formatPainter: fp});
  return {picked: fp.range, sticky: fp.sticky};
}

function paint(ctx, fp, destText) {
  const src0 = fp.source;
  const srcSi = src0.sheets.findIndex(x => x.id === fp.sheetId);
  if (srcSi < 0) throw failed('Pick up a format first.');
  const srcSheet = src0.sheets[srcSi];
  const src = parseRange(fp.range);
  const content = ctx.doc;
  const split = splitRef(content, destText);
  const areas = parseAreas(split.body);
  if (!areas) throw bad('apply', `not a range: \`${destText}\``);
  const destSi = split.sheet ?? gridSel(ctx).sheet;
  requireSchema2(ctx, destSi);
  let dest = areas[0];
  const h = height(src), w = width(src);
  const same = src0.styles === content.styles;
  const styleMap = new Map();
  const mapStyle = id => {
    if (same) return id ?? 0;
    const k = id ?? 0;
    if (!styleMap.has(k)) styleMap.set(k, internStyle(ctx.change, ctx.doc, styleById(src0, k)));
    return styleMap.get(k);
  };
  const setStyle = (row, col, st) => {
    const cell = cellAt(ctx.doc.sheets[destSi], row, col);
    writeCell(ctx.change, ctx.doc, destSi, row, col, {...(cell ?? {}), s: st});
  };
  if (isSingleRange(dest)) dest = {start: {...dest.start}, end: offsetClamped(dest.start, h - 1, w - 1)};
  const rows = isFullRows(dest) && !isFullCols(dest);
  const cols = isFullCols(dest) && !isFullRows(dest);
  const srcFull = (rows && isFullRows(src)) || (cols && isFullCols(src));
  if (rows || cols) {
    // Whole rows or columns take a line format; cells already stored follow the pattern.
    const first = rows ? dest.start.row : dest.start.col, srcFirst = rows ? src.start.row : src.start.col, n = rows ? h : w;
    const [lo, hi] = rows ? [dest.start.row, dest.end.row] : [dest.start.col, dest.end.col];
    for (let line = lo; line <= hi; line++) {
      const sl = srcFirst + ((line - first) % n);
      const at = k => (rows ? {row: sl, col: src.start.col + (k % w)} : {row: src.start.row + (k % h), col: sl});
      const lineStyle = srcFull ? (rows ? srcSheet.rows : srcSheet.cols)?.[sl]?.s : styleIdAt(srcSheet, at(0).row, at(0).col);
      const mapped = lineStyle === undefined || lineStyle === null ? null : mapStyle(lineStyle);
      const axis = rows ? 'rows' : 'cols';
      const info = ctx.change.get(['sheets', destSi, axis, String(line)]) ?? {};
      const nextInfo = {...info};
      if (mapped) nextInfo.s = mapped; else delete nextInfo.s;
      setIn(ctx.change, ['sheets', destSi, axis, String(line)], nextInfo);
      const cells = [];
      const lineRange = rows ? {start: {row: line, col: 0}, end: {row: line, col: 16_383}} : {start: {row: 0, col: line}, end: {row: 1_048_575, col: line}};
      forEachCell(ctx.doc.sheets[destSi], lineRange.start.row, lineRange.start.col, lineRange.end.row, lineRange.end.col, (row, col) => { cells.push({row, col}); });
      if (srcFull) {
        const sr = rows ? {start: {row: sl, col: 0}, end: {row: sl, col: 16_383}} : {start: {row: 0, col: sl}, end: {row: 1_048_575, col: sl}};
        forEachCell(srcSheet, sr.start.row, sr.start.col, sr.end.row, sr.end.col, (row, col) => { cells.push(rows ? {row: line, col} : {row, col: line}); });
      }
      if (cols) {
        // A row format outranks a column format: the column's cells in formatted rows need their own.
        for (const [r, i] of Object.entries(ctx.doc.sheets[destSi].rows ?? {})) if (i?.s) cells.push({row: Number(r), col: line});
      }
      for (const c of cells) {
        const sc = at(rows ? c.col : c.row);
        setStyle(c.row, c.col, mapStyle(styleIdAt(srcSheet, sc.row, sc.col)));
      }
    }
  } else {
    if (count(dest) > 2_000_000) throw bad('edit.formatPainter', 'range too large');
    for (let row = dest.start.row; row <= dest.end.row; row++) for (let col = dest.start.col; col <= dest.end.col; col++) {
      const sc = {row: src.start.row + ((row - dest.start.row) % h), col: src.start.col + ((col - dest.start.col) % w)};
      setStyle(row, col, mapStyle(styleIdAt(srcSheet, sc.row, sc.col)));
    }
  }
  setGridSelection(ctx, rangeSelection(destSi, dest));
  if (!fp.sticky) ctx.setView({formatPainter: null});
  return {applied: areaAddress(ctx.doc, destSi, dest), sticky: fp.sticky};
}
const isSingleRange = r => r.start.row === r.end.row && r.start.col === r.end.col;

const clearCmd = (id, label, what, extra = {}) => ({
  id, label, risk: 'edit',
  description: `${label} in the selection (or range).`,
  params: s.object({range: RANGE, sheet: SHEET}),
  state: hasDoc,
  run: (ctx, p) => clear(ctx, p, what),
  ...extra,
});

export default defineCommands({
  family: 'edit',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    clearCmd('edit.clearAll', 'Clear All', 'all', {description: 'Clear contents, formats, notes, comments, links and merged areas in the selection (or range).'}),
    clearCmd('edit.clearFormats', 'Clear Formats', 'formats', {description: 'Clear the formats (and merged areas) in the selection, keeping the contents.'}),
    clearCmd('edit.clearContents', 'Clear Contents', 'contents', {shortcut: ['Delete', 'Backspace'],
      description: 'Clear the values and formulas in the selection, keeping the formats (Delete); checked boxes are unchecked first.'}),
    clearCmd('edit.clearComments', 'Clear Comments and Notes', 'comments'),
    {
      ...clearCmd('edit.clearHyperlinks', 'Clear Hyperlinks', 'hyperlinks'),
      description: 'Clear the hyperlinks in the selection, keeping their formatting; formats: true (Remove Hyperlinks) also clears the formatting.',
      params: s.object({range: RANGE, sheet: SHEET, formats: s.optional(s.boolean())}),
    },
    {
      id: 'edit.formatPainter', label: 'Format Painter', risk: 'edit',
      description: 'Pick up the selection\'s formats (sticky: keep painting until Escape); with apply, paint them on that range. Clicked while on, it turns off.',
      params: s.object({
        sticky: s.optional(s.boolean({description: 'Double-click: stays on for several pastes'})),
        apply: s.optional(s.string({min: 1, max: 4096, description: 'The range to paint: /sh:<id>/C3:D4, Sheet1!C3 or C3'})),
      }),
      state(ctx) {
        const st = hasDoc(ctx);
        if (!st.enabled) return st;
        return {enabled: true, checked: !!painterOf(ctx)};
      },
      run(ctx, p) {
        if (p.apply) {
          const fp = painterOf(ctx);
          if (!fp?.source) throw failed('Pick up a format first.');
          return paint(ctx, fp, p.apply);
        }
        // The ribbon toggle: a click while it is on turns it off; a double-click (sticky) keeps it on.
        if (painterOf(ctx) && p.sticky === undefined) { ctx.setView({formatPainter: null}); return {off: true}; }
        return pickUp(ctx, p.sticky);
      },
    },
  ],
});

export {targetSheet};
