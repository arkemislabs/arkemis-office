// Unhide dialog model (View > Unhide; submit: view.unhideWindow): Excel's "Unhide workbook:" list of the hidden
// windows. gridcraft's view.unhideWindow takes a window (or the most recently hidden one) at fb1e59f. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.unhideWindow',
  title: 'Unhide',
  command: 'view.unhideWindow',
  init(ctx) {
    const hidden = (ctx.host?.windows?.state?.()?.windows ?? []).filter(x => x.hidden).map(x => ({id: x.id, title: x.title}));
    return {windows: hidden, window: hidden.at(-1)?.id ?? null};
  },
  validate: v => ((v.windows ?? []).some(x => x.id === v.window) ? [] : [{field: 'window', message: 'Choose a window to unhide.'}]),
  toCommand: v => ({command: 'view.unhideWindow', params: {window: v.window}}),
});
