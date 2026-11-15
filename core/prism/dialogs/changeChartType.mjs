// Change Chart Type (submit: chart.type): the same chooser as Insert Chart, previewing the selected chart's own data
// as the chosen type. Layout as PowerPoint, not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';
import {isSchema2} from '../model/doc.mjs';
import {selectedShapes} from '../lib/format-text.mjs';
import {TYPE_IDS, typeCategory, typesIn, chartPrims, retype} from '../lib/chart.mjs';
import {ctxForSlide, ctxColor} from '../model/resolve.mjs';
import {currentSlideId, slideById} from '../model/doc.mjs';

const first = ctx => (isSchema2(ctx?.doc) ? selectedShapes(ctx).find(s => s.kind?.type === 'chart') ?? null : null);

export default defineDialog({
  id: 'dialog.changeChartType',
  title: 'Change Chart Type',
  command: 'chart.type',
  init(ctx) {
    const type = first(ctx)?.kind.chartType ?? 'column';
    return {type, category: typeCategory(type)};
  },
  derive(v, changed) {
    if (changed.includes('category') && typeCategory(v.type) !== v.category) return {type: typesIn(v.category)[0] ?? v.type};
    if (changed.includes('type')) return {category: typeCategory(v.type)};
    return {};
  },
  validate: v => (TYPE_IDS.includes(v.type) ? [] : [{field: 'type', message: 'Choose a chart type.'}]),
  preview(ctx, v) {
    const sh = first(ctx);
    if (!sh || !TYPE_IDS.includes(v.type)) return null;
    try {
      const sl = slideById(ctx.doc, currentSlideId(ctx.doc, ctx.selection));
      const c = ctxForSlide(ctx.doc, sl);
      const kind = retype(structuredClone(sh.kind), v.type);
      return {...chartPrims(kind, 360, 240, ref => ctxColor(c, ref)), name: v.type};
    } catch { return null; }
  },
  toCommand: v => ({command: 'chart.type', params: {type: v.type}}),
});
