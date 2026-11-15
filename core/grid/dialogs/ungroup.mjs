// Ungroup dialog model (submit: data.ungroup): Rows or Columns, for a block of cells.
// Excel's Ungroup dialog over gridcraft's data.ungroup `by: rows|cols` at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.ungroup',
  title: 'Ungroup',
  command: 'data.ungroup',
  init: () => ({by: 'rows'}),
  validate: () => [],
  toCommand: v => ({command: 'data.ungroup', params: {by: v.by === 'cols' ? 'cols' : 'rows'}}),
});
