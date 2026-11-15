// Compare Side by Side dialog model (View > View Side by Side with more than two windows open): Excel's "Compare
// side by side with:" list. Not in gridcraft (not checked against upstream); the answer goes back to
// view.sideBySide as `with`.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.compareSideBySide',
  title: 'Compare Side by Side',
  init: () => ({windows: [], with: null}),
  validate: v => ((v.windows ?? []).some(x => x.id === v.with) ? [] : [{field: 'with', message: 'Choose a window to compare with.'}]),
  toCommand: v => ({command: 'view.sideBySide', params: {with: v.with}}),
});
