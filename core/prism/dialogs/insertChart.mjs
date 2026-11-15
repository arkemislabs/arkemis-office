// Insert Chart (submit: insert.chart): the chart categories down the left, their types drawn as thumbnails, and a
// preview of the chosen one with its sample data. PowerPoint's Recent, Templates, Map and Surface entries are not
// offered (the chart engine draws none of them). The layout is PowerPoint's, not checked against upstream:
// deckcraft's own chart menu is a plain list of type names (cmd/insert.rs `chart_menu_types`).

import {defineDialog} from '../../kernel/dialog.mjs';
import {TYPE_IDS, typeCategory, typesIn, typePrims} from '../lib/chart.mjs';

export default defineDialog({
  id: 'dialog.insertChart',
  title: 'Insert Chart',
  command: 'insert.chart',
  init() { return {type: 'column', category: 'Column'}; },
  derive(v, changed) {
    if (changed.includes('category') && typeCategory(v.type) !== v.category) return {type: typesIn(v.category)[0] ?? v.type};
    if (changed.includes('type')) return {category: typeCategory(v.type)};
    return {};
  },
  validate: v => (TYPE_IDS.includes(v.type) ? [] : [{field: 'type', message: 'Choose a chart type.'}]),
  preview: (ctx, v) => (TYPE_IDS.includes(v.type) ? {...typePrims(v.type, 360, 240, true), name: v.type} : null),
  toCommand: v => ({command: 'insert.chart', params: {type: v.type}}),
});
