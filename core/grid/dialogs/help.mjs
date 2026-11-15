// Help dialog model (command help.open): a search box over the keyboard shortcuts and commands; the list is drawn by
// src/apps/grid/dialogs/help.tsx from the application's command list. Not in gridcraft (not checked against upstream).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.help',
  title: 'Help',
  command: 'help.open',
  init: () => ({search: ''}),
  validate: () => [],
  toCommand: v => ({command: 'help.open', params: {search: String(v.search ?? '')}}),
});
