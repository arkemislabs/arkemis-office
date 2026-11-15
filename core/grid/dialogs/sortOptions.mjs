// Sort Options (nested in Sort): Case sensitive and Orientation (top to bottom or left to right).
// Excel's dialog; gridcraft keeps both as parameters of data.sort (matchCase, orientation).
// The nested dialog returns its fields to Sort's `options` field as `value`.

import {defineDialog} from '../../kernel/dialog.mjs';

const pack = v => ({caseSensitive: v.caseSensitive === true, orientation: v.orientation === 'columns' ? 'columns' : 'rows'});

export default defineDialog({
  id: 'dialog.sortOptions',
  title: 'Sort Options',
  init: () => ({caseSensitive: false, orientation: 'rows', value: pack({})}),
  derive: v => ({value: pack(v)}),
  validate: () => [],
  toCommand: v => ({command: 'data.sort', params: pack(v)}),
});
