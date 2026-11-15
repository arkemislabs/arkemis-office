// Workbook Statistics dialog model (command review.workbookStatistics): the counts of the active sheet and of
// the workbook. gridcraft shows the command's JSON in a monospaced box (crates/ui-egui/src/dialogs/show.rs);
// the body (src/apps/grid/dialogs/statistics.tsx) lists the same numbers as Excel's dialog does. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. Values: result {sheet, workbook}.

import {defineDialog} from '../../kernel/dialog.mjs';
import {statistics} from '../commands/review.mjs';

export default defineDialog({
  id: 'dialog.statistics',
  title: 'Workbook Statistics',
  command: 'review.workbookStatistics',
  init: ctx => ({result: statistics(ctx)}),
  validate: () => [],
  toCommand: () => ({command: 'review.workbookStatistics', params: {}}),
});
