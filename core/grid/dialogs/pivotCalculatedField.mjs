// Insert Calculated Field dialog model (PivotTable Analyze > Fields, Items & Sets > Calculated Field; submit:
// pivot.calculatedField). Excel's dialog (Name, Formula, the Fields list with Insert Field, and Add / Delete for the
// calculated fields the PivotTable has) over gridcraft's cmd/pivot/fields.rs (`calculated_field`: name, formula,
// delete) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: pivot, name, formula, fields (source fields), calculated [{name, formula}], selected (index in fields, or -1).

import {defineDialog} from '../../kernel/dialog.mjs';
import {findPivot} from '../commands/pivot.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import * as pv from '../lib/pivot.mjs';
import {compile} from '../lib/pivot-calc.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The text a field takes in a formula: bare when it is a plain word, else in single quotes. */
export const fieldText = name => (/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);

/** The problem with a calculated-field formula against the fields of the PivotTable, or null. */
export function formulaProblem(formula, fields, calculated, own) {
  const names = [...fields, ...calculated.map(c => c.name).filter(n => !same(n, own))];
  try { compile(formula, n => names.find(h => same(String(h).trim(), String(n).trim())) ?? null); return null; } catch (e) { return e.message; }
}

export default defineDialog({
  id: 'dialog.pivotCalculatedField',
  title: 'Insert Calculated Field',
  command: 'pivot.calculatedField',
  init(ctx) {
    const [si, pi] = findPivot(ctx, {});
    const content = baseDoc(ctx);
    const pt = content.sheets[si].pivots[pi];
    let fields = [];
    try { fields = pv.readSource(content, pt.source, si).headers; } catch { /* the source is gone */ }
    const calculated = (pt.calculatedFields ?? []).map(c => ({name: c.name, formula: c.formula}));
    let name = 'Field1';
    for (let k = 1; [...fields, ...calculated.map(c => c.name)].some(n => same(n, name)); k++) name = `Field${k + 1}`;
    return {pivot: pt.name, name, formula: '= 0', fields, calculated, selected: -1};
  },
  derive(v, changed) {
    // Picking a calculated field of the PivotTable shows its formula, as Excel's Name box does.
    if (!changed.includes('name')) return {};
    const hit = (v.calculated ?? []).find(c => same(c.name, String(v.name ?? '').trim()));
    return hit ? {formula: hit.formula} : {};
  },
  validate(v) {
    const out = [];
    const name = String(v.name ?? '').trim();
    if (!name) out.push({field: 'name', message: 'Enter a name for the field.'});
    else if ((v.fields ?? []).some(f => same(f, name))) out.push({field: 'name', message: 'PivotTable field name already exists.'});
    const bad = formulaProblem(v.formula, v.fields ?? [], v.calculated ?? [], name);
    if (bad) out.push({field: 'formula', message: bad});
    return out;
  },
  toCommand: v => ({command: 'pivot.calculatedField', params: {pivot: v.pivot, name: String(v.name).trim(), formula: String(v.formula).trim()}}),
});

export {gridSel};
