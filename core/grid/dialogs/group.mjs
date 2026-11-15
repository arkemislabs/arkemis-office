// Group dialog model (submit: data.group): Rows or Columns, for a block of cells.
// Excel's Group dialog over gridcraft's data.group `by: rows|cols` (a block of cells groups rows by
// default) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.group',
  title: 'Group',
  command: 'data.group',
  init: () => ({by: 'rows'}),
  validate: () => [],
  toCommand: v => ({command: 'data.group', params: {by: v.by === 'cols' ? 'cols' : 'rows'}}),
});
