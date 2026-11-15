// PivotTable Design: Style Options (Row Headers, Column Headers, Banded Rows, Banded Columns), Repeat All Item Labels and Blank Rows.
// Not in gridcraft (its PivotTable style is one name and its layout has no repeat or blank-line settings): Excel's behaviour, not checked
// against upstream. A PivotTable stores `styleOptions` ({rowHeaders, columnHeaders, bandedRows, bandedColumns}), `repeatLabels` and `blankRows`;
// the report is written again with them (lib/pivot.mjs: cellStyle, flatten, flattenTabular) and they are kept in .xlsx files
// (pivotTableStyleInfo, insertBlankRow, the x14 fillDownLabelsDefault extension).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import * as pv from '../../lib/pivot.mjs';
import {findPivot, update, pivotState} from '../pivot.mjs';

const UPSTREAM = {repo: 'office', files: ['Excel PivotTable Design > Layout, PivotTable Style Options']};
const PIVOT = s.optional(s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]));
const BASE = {pivot: PIVOT, replace: s.optional(s.boolean()), on: s.optional(s.boolean())};

/** The PivotTable at the selection, or null when there is none. */
const current = ctx => { try { const [si, pi] = findPivot(ctx, {}); return ctx.doc.sheets[si].pivots[pi]; } catch { return null; } };

/** A toggle: `on` sets it, no `on` flips it. `get(pt)` reads the setting, `put(pt, on)` writes it. */
const toggle = (id, label, description, get, put, extra = () => null) => ({
  id, label, risk: 'edit', description: `${description} \`on\` sets it (default: toggle).`, params: s.object(BASE),
  state: ctx => {
    const st = pivotState(ctx);
    if (!st.enabled) return st;
    const pt = current(ctx);
    const off = pt && extra(pt);
    return {...st, ...(off ? {enabled: false, reason: off} : {}), checked: pt ? get(pt) : false};
  },
  run: (ctx, p) => update(ctx, p, pt => { const on = typeof p.on === 'boolean' ? p.on : !get(pt); put(pt, on); return {on}; }),
});
const option = key => [pt => pv.styleOptions(pt)[key], (pt, on) => { pt.styleOptions = {...pv.styleOptions(pt), [key]: on}; }];
const flat = pt => (pt.layout === 'compact' ? 'Repeating labels needs Outline or Tabular form' : null);

export default defineCommands({
  family: 'pivot/design',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    toggle('pivot.rowHeaders', 'Row Headers', 'PivotTable Style Options: Row Headers (a group\'s own label is bold).', ...option('rowHeaders')),
    toggle('pivot.columnHeaders', 'Column Headers', 'PivotTable Style Options: Column Headers (the header rows have the style\'s header look).', ...option('columnHeaders')),
    toggle('pivot.bandedRows', 'Banded Rows', 'PivotTable Style Options: Banded Rows (every other row of the report is shaded).', ...option('bandedRows')),
    toggle('pivot.bandedColumns', 'Banded Columns', 'PivotTable Style Options: Banded Columns (every other value column is shaded).', ...option('bandedColumns')),
    toggle('pivot.repeatLabels', 'Repeat All Item Labels', 'Report Layout > Repeat All Item Labels: every row of an Outline or Tabular report names its groups.',
      pt => pt.repeatLabels === true, (pt, on) => { pt.repeatLabels = on; }, flat),
    toggle('pivot.blankRows', 'Blank Rows', 'Blank Rows > Insert Blank Line after Each Item: an empty row after each outer item.',
      pt => pt.blankRows === true, (pt, on) => { pt.blankRows = on; }),
  ],
});
