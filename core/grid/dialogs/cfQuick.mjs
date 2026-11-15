// The Highlight Cells Rules and Top/Bottom Rules boxes: Greater Than, Less Than, Between, Equal To, Text
// that Contains, A Date Occurring, Duplicate Values, Top 10 Items / %, Bottom 10 Items / %, Above Average and
// Below Average: one value (or two, or a period) and the format to give the cells.
// Translated from gridcraft crates/ui-egui/src/dialogs.rs (`cond_format`: type, operator, value, value2, text,
// period, preset, whose "with" list is cond_format.rs `preset_style`; submit: home.conditionalFormat) at
// 146161b4b450a56e5e59a083ba0478582d1e602b, with Excel's wording per box. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Opened with args {type, operator?, rank?, percent?, bottom?, below?}. Custom Format... gathers a differential
// format through dialog.cfFormatCells (the Body does that). Pure: no DOM.

import {defineDialog} from '../../kernel/dialog.mjs';
import {selectionText} from '../lib/data-dialog.mjs';
import {gridSel} from '../lib/edit-targets.mjs';
import {a1} from '../lib/addr.mjs';
import {blankRuleValues, problems, specFromValues} from '../lib/cond-format-dialog.mjs';

/** The box's title and the sentence before its value (Excel's wording). */
export function quickText(v) {
  const kind = v.ruleType;
  if (kind === 'cells' && v.cellsKind === 'cellValue') {
    const [title, lead] = {greaterThan: ['Greater Than', 'Format cells that are GREATER THAN:'], lessThan: ['Less Than', 'Format cells that are LESS THAN:'],
      between: ['Between', 'Format cells that are BETWEEN:'], equal: ['Equal To', 'Format cells that are EQUAL TO:']}[v.operator] ?? ['Greater Than', 'Format cells that are GREATER THAN:'];
    return {title, lead};
  }
  if (kind === 'cells' && v.cellsKind === 'text') return {title: 'Text That Contains', lead: 'Format cells that contain the text:'};
  if (kind === 'cells') return {title: 'A Date Occurring', lead: 'Format cells that contain a date occurring:'};
  if (kind === 'duplicates') return {title: 'Duplicate Values', lead: 'Format cells that contain:'};
  if (kind === 'rank') {
    const pct = v.rankPercent === true, bottom = v.rankDir === 'bottom';
    return {title: `${bottom ? 'Bottom' : 'Top'} 10 ${pct ? '%' : 'Items'}`, lead: `Format cells that rank in the ${bottom ? 'BOTTOM' : 'TOP'}:`};
  }
  return {title: v.avgDir === 'below' ? 'Below Average' : 'Above Average', lead: 'Format cells that are'};
}

export default defineDialog({
  id: 'dialog.cfQuick',
  title: 'Greater Than',
  command: 'home.conditionalFormat',
  init(ctx, args) {
    const v = blankRuleValues();
    const a = args ?? {};
    const sel = gridSel(ctx);
    const active = `=$${a1(sel.active.row, sel.active.col).replace(/^([A-Z]+)/, '$1$')}`;
    switch (a.type) {
      case 'containsText': Object.assign(v, {ruleType: 'cells', cellsKind: 'text', textOp: 'containsText'}); break;
      case 'timePeriod': Object.assign(v, {ruleType: 'cells', cellsKind: 'dates'}); break;
      case 'duplicate': Object.assign(v, {ruleType: 'duplicates', dupKind: 'duplicate'}); break;
      case 'top10': Object.assign(v, {ruleType: 'rank', rankDir: a.bottom ? 'bottom' : 'top', rank: a.rank ?? 10, rankPercent: a.percent === true}); break;
      case 'aboveAverage': Object.assign(v, {ruleType: 'average', avgDir: a.below ? 'below' : 'above'}); break;
      default: Object.assign(v, {ruleType: 'cells', cellsKind: 'cellValue', operator: ['between', 'equal', 'lessThan', 'greaterThan'].includes(a.operator) ? a.operator : a.operator === 'less' ? 'lessThan' : 'greaterThan'});
    }
    if (v.ruleType === 'cells' && v.cellsKind === 'cellValue') v.value = active;
    return {...v, preset: 'lightRedFillDarkRedText', range: selectionText(ctx), __title: quickText(v).title};
  },
  validate: v => problems(v),
  toCommand: v => ({batch: [{command: 'home.conditionalFormat', params: {range: v.range, rule: specFromValues(v, {presetName: v.preset === 'custom' ? undefined : v.preset})}}]}),
});
