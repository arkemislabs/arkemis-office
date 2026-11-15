// PivotTable Analyze > Show > +/- Buttons, and the click on one: expand or collapse the item beside it.
// Not in gridcraft (its report is plain cells; items collapse through the Fields pane and pivot.collapse): Excel's behaviour, not checked against upstream.
//
// Excel draws a button on each item that has another field inside it (the last field of an axis has none), a minus while it is open and a plus while it is
// collapsed. `pivot.showButtons` turns them off for a PivotTable (kept in the file as showDrill); the worksheet paints them from lib/pivot.mjs `pivotButtons`
// and a click runs `pivot.toggleItem`, which changes the field's collapsed items exactly as pivot.collapse does and writes the report again.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import * as pv from '../../lib/pivot.mjs';
import {gridSel} from '../../lib/edit-targets.mjs';
import {failed, baseDoc, bad} from '../../lib/data-common.mjs';
import {parseCell} from '../../lib/addr.mjs';
import {findPivot, update, pivotState} from '../pivot.mjs';

const UPSTREAM = {repo: 'office', files: ['Excel PivotTable Analyze > Show > +/- Buttons']};
const PIVOT = s.optional(s.union([s.string({min: 1, max: 255}), s.integer({min: 0})]));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The button at `cell` (default the active cell): {pivot, field, label, collapsed}, or null. */
function buttonAt(ctx, p) {
  const sel = gridSel(ctx);
  let at = sel.active;
  if (typeof p.cell === 'string') {
    const c = parseCell(p.cell.replace(/\$/g, '').replace(/^.*!/, ''));
    if (!c) throw bad('pivot.toggleItem', `not a cell: ${p.cell}`);
    at = c;
  }
  const content = baseDoc(ctx);
  return pv.pivotButtons(content, sel.sheet).find(b => b.row === at.row && b.col === at.col && (p.pivot === undefined || eq(b.pivot, p.pivot))) ?? null;
}

function toggleItem(ctx, p) {
  const b = buttonAt(ctx, p);
  if (!b) throw failed('Select an item of a PivotTable that has another field inside it.');
  const to = typeof p.collapse === 'boolean' ? p.collapse : !b.collapsed;
  update(ctx, {pivot: b.pivot, replace: p.replace}, pt => {
    const f = [...pt.rows, ...pt.columns].find(x => eq(x.sourceCol, b.field));
    f.collapsedItems = (f.collapsedItems ?? []).filter(x => !eq(x, b.label));
    if (to) f.collapsedItems.push(b.label);
    return {};
  });
  return {pivot: b.pivot, field: b.field, item: b.label, collapsed: to};
}

function showButtons(ctx, p) {
  const [si, pi] = findPivot(ctx, p);
  const cur = ctx.doc.sheets[si].pivots[pi].showButtons !== false;
  const on = typeof p.on === 'boolean' ? p.on : !cur;
  ctx.change.set(['sheets', si, 'pivots', pi, 'showButtons'], on);
  return {on};
}

export default defineCommands({
  family: 'pivot/buttons',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'pivot.showButtons', label: '+/- Buttons', risk: 'edit',
      description: 'PivotTable Analyze > Show > +/- Buttons: the expand and collapse buttons beside the items of the report (`on`, default: toggle).',
      params: s.object({pivot: PIVOT, on: s.optional(s.boolean())}),
      state: ctx => {
        const st = pivotState(ctx);
        if (!st.enabled) return st;
        try { const [si, pi] = findPivot(ctx, {}); return {...st, checked: ctx.doc.sheets[si].pivots[pi].showButtons !== false}; } catch { return {...st, checked: true}; }
      },
      run: showButtons},
    {id: 'pivot.toggleItem', label: 'Expand/Collapse Item', risk: 'edit',
      description: 'A click on the +/- button of an item: expands or collapses the item at `cell` (default the active cell); `collapse` sets it, else it flips. Only an item with another field inside it has a button.',
      params: s.object({pivot: PIVOT, cell: s.optional(s.string({max: 64})), collapse: s.optional(s.boolean()), replace: s.optional(s.boolean())}),
      state: (ctx, p) => {
        const st = pivotState(ctx);
        if (!st.enabled) return st;
        try { return buttonAt(ctx, p ?? {}) ? st : {enabled: false, hidden: true, reason: 'select an item that has another field inside it'}; } catch { return st; }
      },
      run: toggleItem},
  ],
});
