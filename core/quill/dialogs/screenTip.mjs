// Insert Hyperlink › ScreenTip…: Word's Set Hyperlink ScreenTip box, one text. The tip goes back to the Insert Hyperlink dialog and is saved
// as the hyperlink's w:tooltip (it runs no command of its own).

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.screenTip',
  title: 'Set Hyperlink ScreenTip',
  init: () => ({tip: ''}),
  validate: v => (String(v.tip ?? '').length > 255 ? [{field: 'tip', message: 'The ScreenTip is too long (255 characters at most).'}] : []),
  toCommand: () => ({command: 'insert.link', params: {top: true}}),
});
