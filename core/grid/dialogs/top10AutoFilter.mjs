// Top 10 AutoFilter dialog model (submit: data.filterBy {top}): Show Top or Bottom, a number, Items or Percent.
// Excel's Top 10 AutoFilter over gridcraft's FilterCriterion::Top10 {bottom, percent, count}
// (cmd/data/filter.rs `apply_filter`: the threshold is the count-th largest or smallest value, or the
// percent of the numbers rounded up) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.top10AutoFilter',
  title: 'Top 10 AutoFilter',
  command: 'data.filterBy',
  init: () => ({column: 'A', side: 'top', count: 10, unit: 'items'}),
  validate: v => (Number.isInteger(v.count) && v.count >= 1 && v.count <= 500 ? [] : [{field: 'count', message: 'Enter a whole number from 1 to 500.'}]),
  toCommand: v => ({command: 'data.filterBy', params: {column: v.column, top: {count: v.count, bottom: v.side === 'bottom', percent: v.unit === 'percent'}}}),
});
