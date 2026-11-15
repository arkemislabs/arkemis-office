// Check Performance dialog model (Review > Performance; command review.checkPerformance). Excel shows a pane of the issues found with
// a Clean up action beside the ones that can be fixed; here the same list is a dialog (src/apps/grid/dialogs/checkPerformance.tsx).
// Not in gridcraft: Excel's behaviour, not checked against upstream.
//
// Values: findings ([{id, kind, sheet, count, title, detail, fix?}]).

import {defineDialog} from '../../kernel/dialog.mjs';
import {checkPerformance} from '../commands/review/checks.mjs';

export default defineDialog({
  id: 'dialog.checkPerformance',
  title: 'Check Performance',
  command: 'review.checkPerformance',
  init: ctx => ({findings: checkPerformance(ctx).findings}),
  validate: () => [],
  toCommand: () => ({command: 'review.checkPerformance', params: {}}),
});
