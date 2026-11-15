// Add View dialog model (opened by Custom Views > Add…; submit: view.customViews {save}). Excel asks for the name and which settings the
// view keeps (Print settings, Hidden rows, columns and filter settings); this application's view keeps the sheet, the selection, the zoom
// and the frozen panes, so only the name is asked. Not in gridcraft (not checked against upstream). Values: name.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.addView',
  title: 'Add View',
  command: 'view.customViews',
  init: () => ({name: ''}),
  validate: v => (String(v.name ?? '').trim() ? [] : [{field: 'name', message: 'Type a name for the view.'}]),
  toCommand: v => ({command: 'view.customViews', params: {save: String(v.name).trim()}}),
});
