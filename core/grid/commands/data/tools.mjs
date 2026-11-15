// Data > Data Tools > Remove Duplicates and Text to Columns.
// Translated from gridcraft crates/engine/src/cmd/data/tools.rs (`remove_duplicates`,
// `text_to_columns`, `split_delimited`) and cmd/data.rs (specs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Remove Duplicates compares the text the cells show, ignoring case, over the chosen columns of the
// range (header row optional); the first of each run of equal rows stays and the rows below move up.
// Text to Columns splits the text of the first column of the range at delimiters (with a text
// qualifier, optionally treating consecutive delimiters as one) or at fixed positions and types each
// part into the cells from the destination on. Beyond upstream, `columnFormats` gives the wizard's third
// step: per output column general, text, date or skip (do not import).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, rangeA1, parseCell, intersection, rangeOf, rangeCell} from '../../lib/addr.mjs';
import {display} from '../../lib/value.mjs';
import {engineFor} from '../../model/calc.mjs';
import {inputToCell, putCell} from '../../model/input.mjs';
import {cellAt, writeCell, usedBounds} from '../../model/store.mjs';
import {splitDelimited, splitFixed} from '../../lib/data-split.mjs';
import {hasDoc, targetRange, cellParamOn, targetSheet, requireSchema2} from '../../lib/edit-targets.mjs';
import {dataTarget, guessHeader, colParam, valueOf, textOf, bad, baseDoc} from '../../lib/data-common.mjs';

export {splitDelimited, splitFixed};

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/data.rs', 'crates/engine/src/cmd/data/tools.rs']};
const RANGE = s.optional(s.string({min: 1, max: 4096}));
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));

function removeDuplicates(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, range: r0} = dataTarget(ctx, p, 'data.removeDuplicates');
  const sheet = requireSchema2(ctx, si);
  const engine = engineFor(content);
  // Rows and columns past the data are blank: only the part with data is compared.
  const u = usedBounds(sheet);
  const r = (u && intersection(r0, rangeOf(u.r0, u.c0, u.r1, u.c1))) ?? rangeCell(r0.start);
  const header = typeof p.header === 'boolean' ? p.header : guessHeader(content, si, r, engine);
  const cols = Array.isArray(p.columns) ? p.columns.map(c => colParam(c, r.start.col)).filter(c => c !== null) : [...Array(r.end.col - r.start.col + 1).keys()].map(i => r.start.col + i);
  // With no column to compare every row key is empty; a column outside the range compares data nobody selected.
  if (!cols.length || cols.some(c => c < r.start.col || c > r.end.col)) throw bad('data.removeDuplicates', '`columns` must name at least one column of the range');
  const start = r.start.row + (header ? 1 : 0);
  const seen = new Set();
  const keep = [];
  let removed = 0;
  for (let row = start; row <= r.end.row; row++) {
    const key = JSON.stringify(cols.map(c => textOf(content, si, row, c, valueOf(engine, si, row, c)).toLowerCase()));
    if (seen.has(key)) removed++; else { seen.add(key); keep.push(row); }
  }
  if (removed) {
    const moved = keep.map(row => { const out = []; for (let c = r.start.col; c <= r.end.col; c++) out.push(cellAt(sheet, row, c)); return out; });
    for (let row = start; row <= r.end.row; row++) {
      const i = row - start;
      for (let c = r.start.col; c <= r.end.col; c++) {
        const cell = i < moved.length ? moved[i][c - r.start.col] : null;
        writeCell(ctx.change, ctx.doc, si, row, c, cell ? {...cell} : null);
      }
    }
    // Notes, comments and hyperlinks describe cells: the ones of kept rows move up with them, the rest go.
    for (const name of ['notes', 'comments', 'hyperlinks']) {
      const map = sheet[name];
      if (!map || !Object.keys(map).length) continue;
      const next = {};
      for (const k of Object.keys(map)) {
        const c = parseCell(k);
        if (c && c.row >= start && c.row <= r.end.row && c.col >= r.start.col && c.col <= r.end.col) continue;
        next[k] = map[k];
      }
      keep.forEach((row, i) => { for (let c = r.start.col; c <= r.end.col; c++) { const v = map[a1(row, c)]; if (v !== undefined) next[a1(start + i, c)] = v; } });
      ctx.change.set(['sheets', si, name], next);
    }
  }
  const result = {removed, remaining: r.end.row + 1 - start - removed};
  // Excel tells what it did (a notice the worksheet shows when the dialog is open; not part of the document).
  ctx.setView({dataNotice: {id: `rd${ctx.host?.uid?.() ?? Date.now()}`, kind: 'removeDuplicates', ...result}});
  return result;
}

function textToColumns(ctx, p) {
  const content = baseDoc(ctx);
  const sheet = targetSheet(ctx, p);
  requireSchema2(ctx, sheet);
  const {range: r} = targetRange(ctx, p);
  const delims = Array.isArray(p.delimiters) ? p.delimiters.filter(d => typeof d === 'string' && d.length).map(d => [...d][0]) : ['\t'];
  if (typeof p.other === 'string' && p.other.length) delims.push([...p.other][0]);
  const fixed = Array.isArray(p.fixedWidths) ? p.fixedWidths.filter(Number.isInteger) : null;
  const consecutive = p.treatConsecutive === true;
  const quote = p.textQualifier === undefined ? '"' : p.textQualifier === '' || p.textQualifier === 'none' ? '' : [...String(p.textQualifier)][0];
  const dest = cellParamOn(ctx, p, 'destination', sheet) ?? r.start;
  const formats = Array.isArray(p.columnFormats) ? p.columnFormats : [];
  const engine = engineFor(content);
  const out = [];
  for (let i = 0; i <= r.end.row - r.start.row; i++) {
    const text = display(valueOf(engine, sheet, r.start.row + i, r.start.col));
    const parts = fixed ? splitFixed(text, fixed) : splitDelimited(text, delims, consecutive, quote);
    let j = 0;
    parts.forEach((part, k) => {
      const fmt = formats[k] ?? 'general';
      if (fmt === 'skip') return;
      out.push({row: dest.row + i, col: dest.col + j, text: part, fmt});
      j++;
    });
  }
  for (const o of out) {
    if (o.row >= 1_048_576 || o.col >= 16_384) throw bad('data.textToColumns', 'the parts do not fit on the sheet');
    let cell;
    if (o.fmt === 'text' && o.text !== '') cell = {v: o.text};
    else {
      cell = inputToCell(ctx.change, ctx.doc, sheet, o.row, o.col, o.text);
    }
    putCell(ctx.change, ctx.doc, sheet, o.row, o.col, cell, o.text);
  }
  return null;
}

export default defineCommands({
  family: 'data/tools',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'data.removeDuplicates', label: 'Remove Duplicates', risk: 'edit', dialog: 'dialog.removeDuplicates',
      description: 'Delete the rows of a range whose chosen columns repeat an earlier row (compared by shown text, ignoring case); the rows below move up. Returns {removed, remaining}.',
      params: s.object({range: RANGE, sheet: SHEET, columns: s.optional(s.array(s.union([s.string({min: 1, max: 4}), s.integer({min: 0})]), {max: 16_384})), header: s.optional(s.boolean())}),
      state: hasDoc,
      run: removeDuplicates,
    },
    {
      id: 'data.textToColumns', label: 'Text to Columns', risk: 'edit', dialog: 'dialog.textToColumns',
      description: 'Split the text of the first column of the range into columns, at delimiters (delimiters, other, treatConsecutive, textQualifier) or at fixedWidths (break positions), into cells from `destination` (default: the range\'s first cell). columnFormats: general|text|skip per part.',
      params: s.object({
        range: RANGE, sheet: SHEET, delimiters: s.optional(s.array(s.string({max: 4}), {max: 16})), other: s.optional(s.string({max: 4})),
        fixedWidths: s.optional(s.array(s.integer({min: 0}), {max: 1000})), treatConsecutive: s.optional(s.boolean()),
        textQualifier: s.optional(s.string({max: 4})), destination: s.optional(s.string({max: 600})),
        columnFormats: s.optional(s.array(s.enum(['general', 'text', 'skip']), {max: 1000})),
      }),
      state: hasDoc,
      run: textToColumns,
    },
  ],
});
