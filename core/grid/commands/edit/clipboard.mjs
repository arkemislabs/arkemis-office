// Cut, Copy, Paste, Paste Special, Cancel Copy (Escape) for Grid.
// Translated from gridcraft crates/engine/src/cmd/edit/clipboard.rs (`copy_impl`, `copy`, `cut`,
// `clear_clipboard`, `paste`, `paste_text`, `numeric_from_html`, `What`) and
// crates/engine/src/cmd/edit/paste_special.rs (`paste_special`, `tiled_cells`, `apply_operation`,
// `operation_symbol`, `copy_merges`, `rewrite_all_formulas`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The copy keeps a snapshot of the workbook (the immutable content, as gridcraft keeps an
// `Arc<Workbook>`) in the session clipboard (`kind: 'grid.range'`), writes the tab-separated text
// and an HTML table to the system clipboard through the Host, and the surface shows the copied
// range with marching ants while the clipboard holds it (design note U-grid-edit--F-grid--marching-ants).
// A cut pasted in the same workbook moves the cells, their notes, links and merges, and every
// reference to them, in one undo step. Excel options beyond upstream: Values & Source Formatting
// (`keepFormats`), All using Source theme and All merging conditional formats.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {writeClipboard} from '../../../common/lib/clipboard.mjs';
import {a1, rangeA1, parseRange, height, width, count, isSingle, isFullCols, isFullRows, intersection, union, contains, containsRange, offset, offsetClamped, rangeCell, quoteSheet} from '../../lib/addr.mjs';
import {parse, print, shiftRelative, adjust, mapExpr, parseName} from '../../lib/formula.mjs';
import {toNumber, numberToText, fromJSONValue, toJSONValue, CellError, ERR} from '../../lib/value.mjs';
import {inputToCell} from '../../model/input.mjs';
import {cellAt, writeCell, forEachCell, usedBounds, hasContent} from '../../model/store.mjs';
import {styleById, internStyle, deriveStyle, resolveStyle, resolveColor, hex} from '../../model/style.mjs';
import {currentArea} from '../../model/workbook.mjs';
import {engineFor} from '../../model/calc.mjs';
import {rangeText, rangeHtml, parseTsv, tableCells, normalized, formatFor, slideTogether} from '../../lib/edit-clip.mjs';
import {setIn, keysIn, removeMerges, addMerge, removeRuleCells, addRule, ruleAt, ruleRanges, moveRuleFormula} from '../../lib/edit-parts.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, cellParamOn, bad, failed, requireSchema2, setGridSelection, sheetPath, areaAddress, baseDoc} from '../../lib/edit-targets.mjs';
import {guardWrite} from './cell.mjs';
import {pastePicture, PICTURE_KIND} from '../main/picture.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b',
  files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/edit/clipboard.rs', 'crates/engine/src/cmd/edit/paste_special.rs']};

export const CLIP_KIND = 'grid.range';
export const PASTE_WHAT = Object.freeze(['all', 'formulas', 'values', 'formats', 'comments', 'notes', 'validation', 'allExceptBorders', 'columnWidths',
  'formulasAndNumberFormats', 'valuesAndNumberFormats', 'allUsingSourceTheme', 'allMergingConditionalFormats']);
export const OPERATIONS = Object.freeze(['none', 'add', 'subtract', 'multiply', 'divide']);
const MULTIPLE = "This action won't work on multiple selections.";

/** The grid range the session clipboard holds: {docId, sheetId, sheetName, range, cut, areas, selected, text, source} or null. */
export function gridClip(ctx) {
  const c = ctx.clipboard;
  if (!c || c.app !== 'grid' || c.kind !== CLIP_KIND || !c.data) return null;
  return c.data;
}
/** gridcraft `has_clipboard`. */
const hasClipboard = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return gridClip(ctx) ? {enabled: true} : {enabled: false, reason: 'the clipboard is empty'};
};

const trimEol = t => String(t).replace(/[\r\n]+$/, '');

// ---------------------------------------------------------------------------------------------
// Copy / Cut

async function copyImpl(ctx, p, cut) {
  const {sheet, areas: ranges} = targetRanges(ctx, p);
  requireSchema2(ctx, sheet);
  if (ranges.length > 1 && cut) throw failed(MULTIPLE);
  const content = ctx.doc;
  const sh = content.sheets[sheet];
  // The selection as made (untrimmed), for Insert Copied Cells.
  const selected = ranges[0];
  const trim = r => {
    if (!isFullCols(r) && !isFullRows(r)) return r;
    const b = usedBounds(sh);
    const used = b ? {start: {row: b.r0, col: b.c0}, end: {row: b.r1, col: b.c1}} : rangeCell(r.start);
    return intersection(r, union(used, rangeCell(r.start))) ?? r;
  };
  let source = content, range, areas = [];
  if (ranges.length > 1) {
    areas = ranges.map(trim);
    const packed = slideTogether(content, sheet, areas);
    if (!packed) throw failed(MULTIPLE);
    source = packed.content;
    range = packed.block;
  } else range = trim(selected);
  const text = rangeText(source, sheet, range);
  const html = rangeHtml(source, sheet, range, text);
  const data = {docId: ctx.docId, sheetId: sh.id, sheetName: sh.name, range: rangeA1(range), cut, areas: areas.map(rangeA1), selected: rangeA1(selected), text};
  // The workbook snapshot travels with the clipboard but is never serialized.
  Object.defineProperty(data, 'source', {value: source, enumerable: false});
  await writeClipboard(ctx, {text, html: html ?? '', kind: CLIP_KIND, data, label: `${cut ? 'Cut' : 'Copy'} ${sh.name}!${rangeA1(range)}`});
  const out = {range: rangeA1(range), address: areaAddress(content, sheet, range), text};
  if (p.html === true && html) out.html = html;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paste text from outside

/** clipboard.rs `numeric_from_html`: text that is a number the source recorded in its HTML. */
function numericFromHtml(ctx, cell, field, hc) {
  if (!hc || hc.num === null || hc.num === undefined || !cell) return cell;
  if (cell.f !== undefined || typeof cell.v !== 'string') return cell;
  const styles = {styles: ctx.change.get(['styles']) ?? ctx.doc.styles};
  if (resolveStyle(styleById(styles, cell.s)).numFmt === '@') return cell;
  if (normalized(hc.text) !== normalized(field)) return cell;
  const out = {...cell, v: hc.num};
  if (resolveStyle(styleById(styles, cell.s)).numFmt === 'General') {
    const code = formatFor(field, hc.num);
    if (code) out.s = deriveStyle(ctx.change, ctx.doc, cell.s ?? 0, {numFmt: code});
  }
  return out;
}

function pasteText(ctx, p, text, html) {
  baseDoc(ctx);
  const sheet = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, sheet);
  const at = cellParamOn(ctx, p, 'at', sheet) ?? currentArea(gridSel(ctx)).start;
  const rows = parseTsv(text);
  const h = rows.length, w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cells = typeof html === 'string' && html ? tableCells(html, h, w) : [];
  rows.forEach((row, ri) => row.forEach((v, ci) => {
    const c = offset(at, ri, ci);
    if (!c) return;
    let cell;
    try { cell = inputToCell(ctx.change, ctx.doc, sheet, c.row, c.col, v); } catch { cell = {v}; }
    cell = numericFromHtml(ctx, cell, v, cells[ri]?.[ci]);
    guardWrite(ctx, sheet, c.row, c.col, cell);
    writeCell(ctx.change, ctx.doc, sheet, c.row, c.col, cell);
  }));
  if (h > 0 && w > 0) {
    const end = offsetClamped(at, h - 1, w - 1);
    setGridSelection(ctx, {sheet, active: {...at}, anchor: {...at}, ranges: [{start: {...at}, end}]});
  }
  return {rows: h, cols: w};
}

// ---------------------------------------------------------------------------------------------
// Paste Special (paste_special.rs)

const operationSymbol = op => ({add: '+', subtract: '-', multiply: '*', divide: '/'})[op] ?? null;
const isNum = v => typeof v === 'number';
const isEmpty = v => v === null || v === undefined;
const isTxt = v => typeof v === 'string';
const isErr = v => v instanceof CellError;
const numOf = v => { const n = toNumber(v); return typeof n === 'number' ? n : null; };

/** paste_special.rs `apply_operation`: combine the pasted number with what the cell holds. */
function applyOperation(op, old, oldValue, next) {
  const operand = fromJSONValue(next.v);
  const x = numOf(oldValue), y = numOf(operand);
  if (x !== null && y !== null && (isNum(oldValue) || isEmpty(oldValue) || isTxt(oldValue)) && (isNum(operand) || isEmpty(operand))) {
    let r;
    switch (op) {
      case 'add': r = x + y; break;
      case 'subtract': r = x - y; break;
      case 'multiply': r = x * y; break;
      case 'divide': r = y === 0 ? ERR.Div0 : x / y; break;
      default: r = operand;
    }
    next.v = r instanceof CellError ? toJSONValue(r) : (typeof r === 'number' && !Number.isFinite(r) ? toJSONValue(ERR.Num) : r);
  } else if ((isTxt(oldValue) || isErr(oldValue)) && (isNum(operand) || isEmpty(operand))) {
    next.v = toJSONValue(oldValue);
  }
  const sym = operationSymbol(op);
  if (old?.f !== undefined && y !== null && (isNum(operand) || isEmpty(operand)) && sym) {
    next.f = `(${old.f})${sym}${numberToText(y)}`;
    delete next.v;
  }
}

const qualifyCurrentSheet = (e, name) => mapExpr(e, x => (x.t === 'ref' && x.sheet?.k === 'cur' ? {...x, sheet: {k: 'named', name}} : x));

/** paste_special.rs `rewrite_all_formulas`: a reference adjustment over every formula and defined name. */
export function rewriteAllFormulas(change, content, target, edit) {
  for (let si = 0; si < content.sheets.length; si++) {
    const sh = content.sheets[si];
    const host = sh.name;
    const writes = [];
    forEachCell(sh, 0, 0, 1_048_575, 16_383, (row, col, cell) => {
      if (cell.f === undefined) return;
      let e;
      try { e = parse(cell.f); } catch { return; }
      const text = print(adjust(e, host, target, edit));
      if (text !== cell.f) writes.push([row, col, {...cell, f: text}]);
    });
    for (const [row, col, cell] of writes) writeCell(change, content, si, row, col, cell);
  }
  const names = change.get(['names']);
  if (Array.isArray(names)) {
    names.forEach((n, i) => {
      let e;
      try { e = parseName(String(n.formula).replace(/^=/, '')); } catch { return; }
      const text = print(adjust(e, '\u0000', target, edit));
      const was = String(n.formula).replace(/^=/, '');
      if (text !== was) change.set(['names', i, 'formula'], String(n.formula).startsWith('=') ? `=${text}` : text);
    });
  }
}

function themed(style, srcContent, dstContent) {
  // All using Source theme: theme colours become the colours they showed in the source workbook.
  if (!style || !srcContent.theme || srcContent.theme === dstContent.theme) return style;
  const fix = c => (c && typeof c === 'object' && Number.isInteger(c.theme) ? hex(resolveColor(c, srcContent.theme)) : c);
  const out = {...style};
  if (out.font?.color) out.font = {...out.font, color: fix(out.font.color)};
  if (out.fill) out.fill = {...out.fill, fg: fix(out.fill.fg), bg: fix(out.fill.bg)};
  if (out.borders) out.borders = Object.fromEntries(Object.entries(out.borders).map(([k, b]) => [k, b ? {...b, color: fix(b.color)} : b]));
  return out;
}

/** The paste itself. `clip` is the clipboard data; p the edit.pasteSpecial params. */
function pasteSpecialNow(ctx, clip, p) {
  baseDoc(ctx);
  let what = p.what ?? 'all';
  if (what === 'notes') what = 'comments';
  if (!PASTE_WHAT.includes(what)) throw bad('edit.pasteSpecial', `unknown \`what\`: ${what}`);
  const op = p.operation ?? 'none';
  const skipBlanks = !!p.skipBlanks, transpose = !!p.transpose, link = !!p.link;
  const asAll = what === 'all' || what === 'allUsingSourceTheme' || what === 'allMergingConditionalFormats';
  if (link && clip.areas.length) throw failed(MULTIPLE);
  const destSheet = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, destSheet);
  const sel = currentArea(gridSel(ctx));
  const atParam = cellParamOn(ctx, p, 'at', destSheet);
  const at = atParam ?? sel.start;
  const src = parseRange(clip.range);
  const [h, w] = transpose ? [width(src), height(src)] : [height(src), width(src)];
  // Tile the copy over a larger destination that is a multiple of its size.
  const tile = height(sel) % h === 0 && width(sel) % w === 0 && !isSingle(sel) && !atParam && !isFullCols(sel) && !isFullRows(sel) && count(sel) <= 4_000_000;
  const [tilesR, tilesC] = tile ? [height(sel) / h, width(sel) / w] : [1, 1];
  const sameDoc = ctx.docId === clip.docId;
  const cutMove = clip.cut && sameDoc && asAll;
  const srcContent = clip.source;
  const srcSi = srcContent.sheets.findIndex(x => x.id === clip.sheetId);
  if (srcSi < 0) throw failed('The copied sheet no longer exists.');
  const srcSheet = srcContent.sheets[srcSi];
  const srcName = srcSheet.name;
  const liveSrcSi = ctx.doc.sheets.findIndex(x => x.id === clip.sheetId);
  if (cutMove && liveSrcSi < 0) throw failed('The copied sheet no longer exists.');
  if (cutMove && !offset(at, tilesR * h - 1, tilesC * w - 1)) {
    // Check the whole footprint before the source is emptied, so a move that overflows the grid loses nothing.
    throw failed("The cut area doesn't fit at this position; nothing was moved.");
  }
  const srcEngine = engineFor(srcContent);
  // Values the destination cells hold before the paste (operations combine with them).
  const before = baseDoc(ctx);
  const beforeEngine = engineFor(before);
  const styleMap = new Map();
  const mapStyle = id => {
    if (sameDoc && what !== 'allUsingSourceTheme') return id ?? 0;
    const k = id ?? 0;
    if (!styleMap.has(k)) styleMap.set(k, internStyle(ctx.change, ctx.doc, themed(styleById(srcContent, k), srcContent, ctx.doc)));
    return styleMap.get(k);
  };
  let moved = new Map();
  if (cutMove) {
    // Remove the source first (contents and formats), with its notes, links and merged areas.
    const live = ctx.doc.sheets[liveSrcSi];
    forEachCell(live, src.start.row, src.start.col, src.end.row, src.end.col, (row, col, cell) => { moved.set(`${row},${col}`, cell); });
    for (const k of moved.keys()) { const [row, col] = k.split(',').map(Number); writeCell(ctx.change, ctx.doc, liveSrcSi, row, col, null); }
    for (const map of ['notes', 'comments', 'hyperlinks']) for (const k of keysIn(ctx.doc.sheets[liveSrcSi][map], src)) ctx.change.delete(['sheets', liveSrcSi, map, k]);
    removeMerges(ctx.change, ctx.doc, liveSrcSi, src);
  }
  const destOf = (tr, tc, r, c) => offset(at, tr * h + (transpose ? c : r), tc * w + (transpose ? r : c));
  for (let tr = 0; tr < tilesR; tr++) for (let tc = 0; tc < tilesC; tc++) for (let r = 0; r < height(src); r++) for (let c = 0; c < width(src); c++) {
    const sc = {row: src.start.row + r, col: src.start.col + c};
    const dest = destOf(tr, tc, r, c);
    if (!dest) continue;
    const srcCell = cutMove ? moved.get(`${sc.row},${sc.col}`) ?? null : cellAt(srcSheet, sc.row, sc.col);
    const srcVal = srcEngine.sheetValue(srcSi, sc.row, sc.col);
    if (skipBlanks && isEmpty(srcVal) && srcCell?.f === undefined) continue;
    const old = cellAt(ctx.doc.sheets[destSheet], dest.row, dest.col);
    const inSource = cutMove && destSheet === liveSrcSi && contains(src, dest);
    const oldValue = inSource ? null : beforeEngine.sheetValue(destSheet, dest.row, dest.col);
    const next = old ? {...old} : {};
    const shift = cell => {
      if (cell?.f === undefined) return undefined;
      let e;
      try { e = parse(cell.f); } catch { return cell.f; }
      if (cutMove) {
        // A moved formula still reads cells on its original sheet.
        const q = destSheet !== liveSrcSi ? qualifyCurrentSheet(e, srcName) : e;
        return print(q);
      }
      return print(shiftRelative(e, dest.row - sc.row, dest.col - sc.col));
    };
    const movedArray = cell => {
      if (!cutMove || !cell?.a) return undefined;
      const ar = parseRange(cell.a);
      const s0 = ar && offset(ar.start, dest.row - sc.row, dest.col - sc.col), e0 = ar && offset(ar.end, dest.row - sc.row, dest.col - sc.col);
      return s0 && e0 ? rangeA1({start: s0, end: e0}) : undefined;
    };
    const putFormulaOrValue = (sv, keepArray) => {
      const f = shift(srcCell);
      delete next.a; delete next.d;
      if (f !== undefined) {
        next.f = f; delete next.v;
        if (keepArray) { const a = movedArray(srcCell); if (a) next.a = a; }
        if (srcCell?.d) next.d = true;
      } else {
        delete next.f;
        if (srcCell && srcCell.v !== undefined) next.v = srcCell.v; else delete next.v;
      }
      void sv;
    };
    if (link) {
      const prefix = destSheet === liveSrcSi && sameDoc ? '' : `${quoteSheet(srcName)}!`;
      next.f = `${prefix}${a1(sc.row, sc.col)}`;
      delete next.v; delete next.a; delete next.d;
    } else {
      switch (what) {
        case 'all': case 'allExceptBorders': case 'allUsingSourceTheme': case 'allMergingConditionalFormats': {
          putFormulaOrValue(srcVal, true);
          const st = mapStyle(srcCell?.s);
          if (what === 'allExceptBorders') {
            const borders = resolveStyle(styleById({styles: ctx.change.get(['styles']) ?? ctx.doc.styles}, old?.s)).borders;
            next.s = deriveStyle(ctx.change, ctx.doc, st, {borders: {...borders}});
          } else next.s = st;
          break;
        }
        case 'formulas': case 'formulasAndNumberFormats':
          putFormulaOrValue(srcVal, false);
          if (what === 'formulasAndNumberFormats') next.s = deriveStyle(ctx.change, ctx.doc, old?.s ?? 0, {numFmt: resolveStyle(styleById(srcContent, srcCell?.s)).numFmt});
          break;
        case 'values': case 'valuesAndNumberFormats': {
          delete next.f; delete next.a; delete next.d;
          const v = toJSONValue(srcVal);
          if (v === null) delete next.v; else next.v = v;
          if (what === 'valuesAndNumberFormats') next.s = deriveStyle(ctx.change, ctx.doc, old?.s ?? 0, {numFmt: resolveStyle(styleById(srcContent, srcCell?.s)).numFmt});
          // Excel's Values & Source Formatting: the values with the source's whole format.
          if (p.keepFormats && what === 'values') next.s = mapStyle(srcCell?.s);
          break;
        }
        case 'formats': next.s = mapStyle(srcCell?.s); break;
        default: break; // comments, validation, columnWidths write no cell content
      }
      // Operations combine numbers with what is already there.
      if (op !== 'none' && ['all', 'values', 'valuesAndNumberFormats', 'formulas'].includes(what) && next.f === undefined) applyOperation(op, old, oldValue, next);
    }
    // The copied cell's validation rule replaces whatever rule the destination had.
    if (!link && (asAll || what === 'allExceptBorders' || what === 'validation')) {
      const rule = ruleAt(srcSheet.validations, sc);
      const cellRange = rangeCell(dest);
      removeRuleCells(ctx.change, destSheet, 'validations', cellRange);
      if (rule) {
        const first = ruleRanges(rule)[0]?.start ?? sc;
        const moved2 = {...rule, ranges: [a1(dest.row, dest.col)]};
        if (rule.f1 !== undefined) moved2.f1 = moveRuleFormula(rule.f1, first, dest);
        if (rule.f2 !== undefined) moved2.f2 = moveRuleFormula(rule.f2, first, dest);
        // The stored (xlsx) names of the formulas; a literal list stays as typed (U:grid/data).
        for (const k of ['formula1', 'formula2']) if (typeof rule[k] === 'string' && !rule[k].startsWith('"')) moved2[k] = moveRuleFormula(rule[k], first, dest);
        if (moved2.id !== undefined) moved2.id = `${rule.id}-${a1(dest.row, dest.col)}`;
        addRule(ctx.change, destSheet, 'validations', moved2);
      }
    }
    const destKey = a1(dest.row, dest.col), srcKey = a1(sc.row, sc.col);
    const write = () => { guardWrite(ctx, destSheet, dest.row, dest.col, next); writeCell(ctx.change, ctx.doc, destSheet, dest.row, dest.col, next); };
    if (what === 'comments') {
      for (const map of ['notes', 'comments']) if (srcSheet[map]?.[srcKey] !== undefined) setIn(ctx.change, ['sheets', destSheet, map, destKey], srcSheet[map][srcKey]);
    } else if (what === 'columnWidths') {
      const info = srcSheet.cols?.[sc.col];
      if (info !== undefined) setIn(ctx.change, ['sheets', destSheet, 'cols', String(dest.col)], info);
    } else if (what === 'validation') {
      // the rule alone
    } else if (asAll && !link) {
      for (const map of ['notes', 'comments', 'hyperlinks']) if (srcSheet[map]?.[srcKey] !== undefined) setIn(ctx.change, ['sheets', destSheet, map, destKey], srcSheet[map][srcKey]);
      write();
    } else write();
  }
  // Merged areas inside the copied block travel with it.
  if ((asAll || what === 'formats') && !transpose && !link) {
    for (const m of (srcSheet.merges ?? []).map(parseRange)) {
      if (!m || !containsRange(src, m)) continue;
      const s0 = offset(m.start, at.row - src.start.row, at.col - src.start.col), e0 = offset(m.end, at.row - src.start.row, at.col - src.start.col);
      if (s0 && e0) addMerge(ctx.change, ctx.doc, destSheet, {start: s0, end: e0});
    }
  }
  // Excel's All merging conditional formats: the source's rules join the destination's.
  if (what === 'allMergingConditionalFormats' && !link) {
    for (const rule of srcSheet.conditionalFormats ?? []) {
      const parts = ruleRanges(rule).map(r => intersection(r, src)).filter(Boolean);
      if (!parts.length) continue;
      const ranges = [];
      for (let tr = 0; tr < tilesR; tr++) for (let tc = 0; tc < tilesC; tc++) for (const part of parts) {
        const s0 = offset(at, tr * h + part.start.row - src.start.row, tc * w + part.start.col - src.start.col);
        const e0 = offset(at, tr * h + part.end.row - src.start.row, tc * w + part.end.col - src.start.col);
        if (s0 && e0) ranges.push(rangeA1({start: s0, end: e0}));
      }
      if (ranges.length) addRule(ctx.change, destSheet, 'conditionalFormats', {...rule, ...(rule.id !== undefined ? {id: `${rule.id}-${ctx.host.uid?.() ?? Date.now().toString(36)}`} : {}), ranges});
    }
  }
  if (cutMove) {
    // References elsewhere to the moved block now point to its new place.
    const destName = ctx.doc.sheets[destSheet].name;
    const edit = destSheet === liveSrcSi
      ? {type: 'move', from: src, toRow: at.row, toCol: at.col}
      : {type: 'moveToSheet', from: src, toSheet: destName, toRow: at.row, toCol: at.col};
    rewriteAllFormulas(ctx.change, ctx.doc, srcName, edit);
  }
  const end = offsetClamped(at, tilesR * h - 1, tilesC * w - 1);
  const range = {start: {...at}, end};
  setGridSelection(ctx, {sheet: destSheet, active: {...at}, anchor: {...at}, ranges: [range]});
  if (cutMove) ctx.setClipboard(null);
  return {pasted: rangeA1(range), address: areaAddress(ctx.doc, destSheet, range)};
}

async function paste(ctx, p) {
  const clip = gridClip(ctx);
  // Copy as Picture, then Paste: the picture (Office), unless something else has been copied since (the system clipboard no longer holds its text).
  const held = ctx.clipboard;
  if (held && held.app === 'grid' && held.kind === PICTURE_KIND && typeof p.text !== 'string' && typeof ctx.host?.clipboardRead === 'function') {
    let sys = null;
    try { sys = await ctx.host.clipboardRead(); } catch { sys = null; }
    if (!sys || trimEol(sys.text ?? '') === trimEol(held.text ?? '')) return pastePicture(ctx, {});
  }
  if (typeof p.text === 'string') {
    if (!clip || trimEol(clip.text) !== trimEol(p.text)) return pasteText(ctx, p, p.text, p.html);
  } else if (typeof ctx.host?.clipboardRead === 'function') {
    // What the system clipboard holds now: another app's copy wins over ours (common/lib/clipboard.mjs).
    let sys = null;
    try { sys = await ctx.host.clipboardRead(); } catch { sys = null; }
    const text = typeof sys?.text === 'string' ? sys.text : '';
    if (text && (!clip || trimEol(clip.text) !== trimEol(text))) return pasteText(ctx, p, text, typeof sys?.html === 'string' ? sys.html : '');
    // A picture copied in another program (a screenshot) floats over the cells at the selection, as Excel pastes it.
    if (!text && typeof sys?.picture === 'string' && sys.picture) return ctx.run('insert.picture', {dataUrl: sys.picture, ...(p.at ? {at: p.at} : {}), alt: 'Pasted picture'});
  }
  if (!clip) throw failed('Nothing to paste.');
  return pasteSpecialNow(ctx, clip, {what: 'all', at: p.at});
}

const RANGE = s.optional(s.string({min: 1, max: 4096, description: 'Range: /sh:<id>/A1:C9, Sheet1!A1:C9 or A1:C9 (default: the selection)'}));
const AT = s.optional(s.string({min: 1, max: 600, description: 'Top-left cell of the paste: /sh:<id>/C3, Sheet1!C3 or C3 (default: the selection)'}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

export default defineCommands({
  family: 'edit/clipboard',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'Copy the selection (or range): its tab-separated text and an HTML table go to the clipboard; html: true also returns the HTML.',
      params: s.object({range: RANGE, sheet: SHEET, html: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => copyImpl(ctx, p, false),
    },
    {
      id: 'edit.cut', label: 'Cut', shortcut: 'Mod+X', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'Cut the selection: the cells move (with their notes, links, merges and every reference to them) when pasted in this workbook.',
      params: s.object({range: RANGE, sheet: SHEET, html: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => copyImpl(ctx, p, true),
    },
    {
      id: 'edit.paste', label: 'Paste', shortcut: 'Mod+V', risk: 'edit',
      description: 'Paste what was copied or cut at the selection (or at); text from another app is entered as typed input, keeping numbers its HTML records.',
      params: s.object({at: AT, sheet: SHEET, text: s.optional(s.string({max: 10_000_000})), html: s.optional(s.string({max: 16 * 1024 * 1024}))}),
      state: hasDoc,
      run: paste,
    },
    {
      id: 'edit.pasteSpecial', label: 'Paste Special…', shortcut: 'Mod+Alt+V', risk: 'edit', dialog: 'dialog.pasteSpecial',
      description: 'Paste part of what was copied (formulas, values, formats, notes, validation, column widths...), combine it with an operation, skip blanks, transpose or link.',
      params: s.object({
        what: s.optional(s.enum(PASTE_WHAT)),
        operation: s.optional(s.enum(OPERATIONS)),
        skipBlanks: s.optional(s.boolean()), transpose: s.optional(s.boolean()), link: s.optional(s.boolean()),
        keepFormats: s.optional(s.boolean({description: 'Values & Source Formatting: with what=values, the source formats too'})),
        at: AT, sheet: SHEET,
      }),
      state: hasClipboard,
      run(ctx, p) {
        const clip = gridClip(ctx);
        if (!clip) throw failed('Nothing to paste.');
        return pasteSpecialNow(ctx, clip, p);
      },
    },
    {
      id: 'edit.clearClipboard', label: 'Cancel Copy', shortcut: 'Escape', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'End copy mode (the marching ants) and Format Painter.',
      params: s.object({}),
      state: hasDoc,
      run(ctx) {
        if (gridClip(ctx)) ctx.setClipboard(null);
        if (ctx.view?.formatPainter) ctx.setView({formatPainter: null});
        return null;
      },
    },
  ],
});

export {pasteSpecialNow, sheetPath, CommandError, hasContent};
