// PivotTable Analyze: calculated fields, Move PivotTable and Select.
// Translated from gridcraft crates/engine/src/cmd/pivot/fields.rs (`calculated_field`) and pivot_calc.rs (lib/pivot-calc.mjs) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Move PivotTable and Select are not in gridcraft (not checked against upstream): the report moves to another cell, and the whole
// report, its labels or its values are selected, as Excel does. PivotCharts and Recommended PivotTables belong to the Insert tab
// (commands/insert/pivotchart.mjs).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {hasDoc, gridSel, cellParamOn, requireSchema2, setGridSelection, rangeSelection} from '../../lib/edit-targets.mjs';
import {bad, failed, baseDoc} from '../../lib/data-common.mjs';
import {a1, parseRange, rangeA1} from '../../lib/addr.mjs';
import * as pv from '../../lib/pivot.mjs';
import {CalcSet, MAX_CALC_FIELDS} from '../../lib/pivot-calc.mjs';
import {findPivot, update, insertPivot, addToArea, refreshPivot, activeField} from '../pivot.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/pivot/fields.rs', 'crates/engine/src/pivot_calc.rs']};
const PIVOT = s.optional(s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const anyPivot = ctx => (hasDoc(ctx).enabled ? (ctx.doc.sheets.some(sh => (sh.pivots ?? []).length) ? {enabled: true} : {enabled: false, reason: 'select a cell in a PivotTable'}) : hasDoc(ctx));

// ---------------------------------------------------------------- calculated fields

function calculatedField(ctx, p) {
  const C = 'pivot.calculatedField';
  const name = String(p.name ?? '').trim();
  if (!name || [...name].length > 255) throw bad(C, '`name` must be 1 to 255 characters');
  const del = p.delete === true;
  let formula = typeof p.formula === 'string' ? p.formula.trim() : null;
  if (formula !== null && !formula.startsWith('=')) formula = `=${formula}`;
  if (!del && formula === null) throw bad(C, 'missing `formula`');
  const toValues = p.values !== false;
  return update(ctx, p, (pt, src) => {
    pt.calculatedFields ??= [];
    const existing = pt.calculatedFields.findIndex(c => eq(c.name, name));
    if (del) {
      if (existing < 0) throw bad(C, `no calculated field \`${name}\``);
      const [gone] = pt.calculatedFields.splice(existing, 1);
      pt.values = pt.values.filter(v => !eq(v.sourceCol, gone.name));
      return {name: gone.name, deleted: true};
    }
    if (src.col(name) >= 0) throw failed('PivotTable field name already exists.');
    let canon;
    if (existing >= 0) { pt.calculatedFields[existing] = {...pt.calculatedFields[existing], formula}; canon = pt.calculatedFields[existing].name; }
    else {
      if (pt.calculatedFields.length >= MAX_CALC_FIELDS) throw failed(`A PivotTable can have at most ${MAX_CALC_FIELDS} calculated fields.`);
      pt.calculatedFields.push({name, formula});
      canon = name;
    }
    const set = new CalcSet(pt, src.headers);
    const i = set.index(canon);
    if (i < 0) throw failed("There's no such calculated field.");
    if (set.error(i)) throw bad(C, set.error(i));
    if (set.isCyclic(i)) throw bad(C, `\`${canon}\` refers to itself through its formula`);
    if (existing < 0 && toValues && !pt.values.some(v => eq(v.sourceCol, canon))) addToArea(pt, src, {cmd: C, field: canon, area: 'values', func: 'sum'});
    return {name: canon, formula, calculatedFields: pt.calculatedFields.map(c => ({name: c.name, formula: c.formula}))};
  });
}

// ---------------------------------------------------------------- Move PivotTable, Select

/** Moves the report: its first cell goes to `to` (a cell, `Sheet!cell` or `new` for a new sheet); the old report is cleared and the new one written. */
function movePivot(ctx, p) {
  const C = 'pivot.move';
  const [si0, pi] = findPivot(ctx, p);
  requireSchema2(ctx, si0);
  const content = baseDoc(ctx);
  const pt0 = content.sheets[si0].pivots[pi];
  const text = String(p.to ?? p.location ?? '').trim();
  if (!text) throw bad(C, 'missing `to`: a cell such as Sheet1!H3, or "new"');
  let si = si0, dest, at;
  if (eq(text, 'new')) {
    // A new sheet before the current one, the report at A3 (as Create PivotTable does).
    ctx.run('home.insertSheet', {before: si0});
    si = si0 + 1; dest = si0; at = {row: 2, col: 0};
  } else {
    const bang = text.lastIndexOf('!');
    const sheetName = bang >= 0 ? text.slice(0, bang).trim().replace(/^'(.*)'$/, (_, x) => x.replace(/''/g, "'")) : null;
    dest = sheetName === null ? si0 : content.sheets.findIndex(x => eq(x.name, sheetName));
    if (dest < 0) throw bad(C, `no sheet named \`${sheetName}\``);
    const r = parseRange((bang >= 0 ? text.slice(bang + 1) : text).replace(/\$/g, ''));
    if (!r) throw bad(C, `not a cell: \`${text}\``);
    at = r.start;
  }
  requireSchema2(ctx, dest);
  const now = ctx.doc;
  const pt = now.sheets[si].pivots[pi];
  const old = pv.pivotRange(pt);
  const clear = () => { if (old) for (let row = old.start.row; row <= old.end.row; row++) for (let col = old.start.col; col <= old.end.col; col++) if (cellAt(ctx.doc.sheets[si], row, col)) writeCell(ctx.change, ctx.doc, si, row, col, {}); };
  const anchor = a1(at.row, at.col);
  if (dest === si) {
    ctx.change.set(['sheets', si, 'pivots', pi, 'anchor'], anchor);
    const range = refreshPivot(ctx, si, pi, p.replace === true);
    return {sheet: now.sheets[si].name, anchor, range};
  }
  // Another sheet takes the PivotTable with it: the old report goes, and PivotCharts follow it.
  clear();
  ctx.change.set(['sheets', si, 'pivots'], now.sheets[si].pivots.filter((_, i) => i !== pi));
  const moved = {...pt, anchor, lastRange: null};
  const target = ctx.doc.sheets[dest];
  ctx.change.set(['sheets', dest, 'pivots'], [...(target.pivots ?? []), moved]);
  const range = refreshPivot(ctx, dest, (target.pivots ?? []).length, p.replace === true);
  setGridSelection(ctx, rangeSelection(dest, {start: at, end: at}));
  return {sheet: target.name, anchor, range};
}

// ---------------------------------------------------------------- Active Field

/** The field under the selected cell: {area, field, index, name} (name: its caption, or a value field's name), or null. */
function fieldHere(ctx, p) {
  const af = activeField(ctx, p);
  if (!af) return null;
  const [si, pi] = findPivot(ctx, p);
  const pt = ctx.doc.sheets[si].pivots[pi];
  const name = af.area === 'values' ? pt.values[af.index]?.name ?? af.field : pt[af.area][af.index]?.caption || af.field;
  return {...af, name};
}

/** PivotTable Analyze > Active Field box: the caption of a row or column field (its heading in the report), or the name of a value field. */
function fieldCaption(ctx, p) {
  const C = 'pivot.fieldCaption';
  const caption = String(p.caption ?? '').trim();
  const here = typeof p.field === 'string' ? {field: p.field} : fieldHere(ctx, p);
  if (!here) throw failed('Select a cell in a field of the PivotTable.');
  return update(ctx, p, (pt, src) => {
    const find = list => list.findIndex(f => eq(f.sourceCol, here.field) || eq(f.caption ?? '', here.field));
    const vi = pt.values.findIndex(v => eq(v.name, here.field) || (here.area === 'values' && eq(v.sourceCol, here.field)));
    if (here.area === 'values' || (here.area === undefined && vi >= 0 && find([...pt.rows, ...pt.columns]) < 0)) {
      if (vi < 0) throw bad(C, `no value field \`${here.field}\``);
      if (!caption) throw failed("The PivotTable field name isn't valid.");
      if (src.col(caption) >= 0 || pt.values.some((x, j) => j !== vi && eq(x.name, caption))) throw failed('PivotTable field name already exists.');
      pt.values[vi] = {...pt.values[vi], name: caption};
      return {name: caption};
    }
    for (const area of ['rows', 'columns', 'filters']) {
      const i = find(pt[area]);
      if (i < 0) continue;
      const f = pt[area][i];
      if (caption && !eq(caption, f.sourceCol)) {
        // A caption never repeats another field's name or caption.
        const taken = src.col(caption) >= 0 || [...pt.rows, ...pt.columns, ...pt.filters].some(x => x !== f && eq(x.caption ?? '', caption)) || pt.values.some(v => eq(v.name, caption));
        if (taken) throw failed('PivotTable field name already exists.');
        f.caption = caption;
      } else delete f.caption;
      return {name: f.caption || f.sourceCol};
    }
    throw bad(C, `no field \`${here.field}\` in the PivotTable`);
  });
}

/** Select > Entire PivotTable, Labels, Values: the report's cells, the label cells of the rows and columns, or the value cells. */
function selectPivot(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  const content = baseDoc(ctx);
  const pt = content.sheets[si].pivots[pi];
  const area = pv.pivotRange(pt);
  if (!area) throw failed('Refresh the PivotTable first.');
  const part = p.part ?? 'entire';
  if (part === 'entire') { setGridSelection(ctx, rangeSelection(si, area)); return {range: rangeA1(area)}; }
  let out;
  try { out = pv.compute(content, pt, si); } catch (e) { throw failed(e.message); }
  const anchor = parseRange(pt.anchor).start;
  const originRow = anchor.row >= out.bodyOffset ? anchor.row - out.bodyOffset : anchor.row;
  if (part === 'body') {
    // Labels and Values: the report without its report filters.
    const body = {start: {row: originRow + out.bodyOffset, col: area.start.col}, end: area.end};
    setGridSelection(ctx, rangeSelection(si, body));
    return {range: rangeA1(body)};
  }
  const cells = [];
  out.grid.forEach((row, ri) => row.forEach((c, ci) => {
    // Subtotal and grand total rows hold their caption (text) in a label column and their sums in the value columns.
    const total = c.kind === 'subtotal' || c.kind === 'grandTotal';
    const label = ['rowLabel', 'colLabel', 'header'].includes(c.kind) || (total && typeof c.value === 'string');
    const value = (c.kind === 'data' || total) && typeof c.value !== 'string';
    if ((part === 'labels' && label) || (part === 'values' && value && c.value !== null && c.value !== undefined)) cells.push({row: originRow + ri, col: anchor.col + ci});
  }));
  if (!cells.length) throw failed('The PivotTable has no such cells.');
  // The selection is the bounding block of those cells (a union of blocks needs a multi-area selection).
  const r0 = Math.min(...cells.map(c => c.row)), r1 = Math.max(...cells.map(c => c.row)), c0 = Math.min(...cells.map(c => c.col)), c1 = Math.max(...cells.map(c => c.col));
  const range = {start: {row: r0, col: c0}, end: {row: r1, col: c1}};
  setGridSelection(ctx, rangeSelection(si, range));
  return {range: rangeA1(range)};
}

export default defineCommands({
  family: 'pivot/calc',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'pivot.calculatedField', label: 'Calculated Field', risk: 'edit', dialog: 'dialog.pivotCalculatedField',
      description: 'Add, change or delete a calculated field of a PivotTable: `name`, `formula` ("=Sales*0.1": field names bare or \'quoted\', evaluated on the sums of each report cell), `delete`, `values` (add a new field to Values, default true).',
      params: s.object({pivot: PIVOT, name: s.string({min: 1, max: 255}), formula: s.optional(s.string({max: 8192})), delete: s.optional(s.boolean()), values: s.optional(s.boolean()), replace: s.optional(s.boolean())}),
      state: anyPivot, run: calculatedField},
    {id: 'pivot.move', label: 'Move PivotTable', risk: 'edit', dialog: 'dialog.movePivotTable',
      description: 'Move a PivotTable\'s report to the cell `to` (A1, or Sheet2!A1); the old report is cleared and the new one written.',
      params: s.object({pivot: PIVOT, to: s.string({min: 1, max: 400}), replace: s.optional(s.boolean())}), state: anyPivot, run: movePivot},
    {id: 'pivot.select', label: 'Select', risk: 'edit', description: 'Select part of a PivotTable\'s report: entire, body (labels and values), labels or values (`part`).',
      params: s.object({pivot: PIVOT, part: s.optional(s.enum(['entire', 'body', 'labels', 'values']))}), state: anyPivot, run: selectPivot},
    {id: 'pivot.fieldCaption', label: 'Active Field', risk: 'edit', description: 'The caption of the field under the selected cell (or `field`): a row, column or filter field\'s heading in the report, or a value field\'s name; an empty caption restores the field name.',
      params: s.object({pivot: PIVOT, field: s.optional(s.string({max: 255})), caption: s.string({max: 255}), replace: s.optional(s.boolean())}),
      state: ctx => {
        const st = anyPivot(ctx);
        if (!st.enabled) return st;
        try { const f = fieldHere(ctx, {}); return f ? {...st, value: f.name} : {...st, enabled: false, reason: 'select a field of the PivotTable'}; } catch { return {...st, enabled: false, reason: 'select a cell in a PivotTable'}; }
      },
      run: fieldCaption},
  ],
});
