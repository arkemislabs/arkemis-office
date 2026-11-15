// Recommended PivotTables dialog model (submit: insert.recommendedPivotTables).
// Excel's Recommended PivotTables (a list of layouts that suit the data with a preview of the one picked) over
// gridcraft's cmd/pivot/charts.rs (`suggestions`: sum by a category, by two, by quarters, two values, count, average)
// at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Blank PivotTable and Change Source Data… are not offered (Create PivotTable has both).
//
// Values: source (the table or range the layouts come from), list (their titles), pick (the index picked).

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {baseDoc} from '../lib/data-common.mjs';
import * as pv from '../lib/pivot.mjs';
import {suggestions, sourceOf} from '../commands/insert/pivotchart.mjs';

/** The suggestions for a source, [] when it cannot be read. */
function suggest(ctx, source) {
  try {
    const content = baseDoc(ctx);
    return suggestions(content, pv.readSource(content, source, gridSel(ctx).sheet));
  } catch { return []; }
}

const line = (y, text, bold = false, color = [50, 50, 50, 255]) => ({t: 'text', x: 10, y, text, size: 11, bold, color, align: 'left', valign: 'top'});

export default defineDialog({
  id: 'dialog.recommendedPivotTables',
  title: 'Recommended PivotTables',
  command: 'insert.recommendedPivotTables',
  init(ctx) {
    let source = '';
    try { source = sourceOf(ctx, {}); } catch { /* no data under the selection: the list is empty */ }
    const list = source ? suggest(ctx, source) : [];
    return {source, list: list.map(x => x.title), pick: 0};
  },
  validate: v => (Array.isArray(v.list) && v.list.length ? [] : [{field: 'list', message: 'Select a cell in a range with labeled columns first.'}]),
  preview(ctx, v) {
    const pick = suggest(ctx, String(v.source ?? ''))[Number(v.pick) || 0];
    if (!pick) return null;
    const name = x => (typeof x === 'string' ? x : x.group ? `${x.field} (${x.group})` : x.field);
    const val = x => `${{sum: 'Sum', count: 'Count', average: 'Average'}[x.func] ?? 'Sum'} of ${x.field}`;
    const prims = [{t: 'rect', x: 0.5, y: 0.5, w: 299, h: 189, radius: 3, fill: [255, 255, 255, 255], stroke: [[200, 200, 200, 255], 1]}, line(10, pick.title, true)];
    let y = 38;
    for (const [label, items] of [['Rows', pick.rows.map(name)], ['Columns', pick.columns.map(name)], ['Values', pick.values.map(val)]]) {
      if (!items.length) continue;
      prims.push(line(y, label, true, [120, 120, 120, 255]));
      for (const it of items) { y += 18; prims.push(line(y, it)); }
      y += 28;
    }
    return {w: 300, h: 190, prims};
  },
  toCommand: v => ({command: 'insert.recommendedPivotTables', params: {source: String(v.source), apply: Number(v.pick) || 0}}),
});
