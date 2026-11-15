// Symbol dialog model (submit: insert.symbol).
// Excel's Symbol dialog (Symbols and Special Characters) over gridcraft's insert.symbol
// (cmd/insert.rs `insert_symbol`: the character goes at the end of the active cell's text) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Values: char (the chosen character), subset (the chosen group of the grid), recent.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.symbol',
  title: 'Symbol',
  command: 'insert.symbol',
  init: () => ({char: '', subset: 'Currency Symbols', recent: []}),
  validate: v => (v.char ? [] : [{field: 'char', message: 'Choose a symbol to insert.'}]),
  toCommand: v => ({command: 'insert.symbol', params: {char: String(v.char)}}),
});
