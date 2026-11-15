// Help tab > Help (F1): the application's own help, a searchable list of the keyboard shortcuts and what the ribbon's commands do,
// drawn from the application's command list. Not in gridcraft (not checked against upstream). Excel's F1 opens Microsoft's online
// help; this application makes no web requests of its own, so Contact Support, Feedback, Show Training, What's New and Check for
// Updates stay hidden (they are Microsoft services).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';

export default defineCommands({
  family: 'main/help',
  app: 'grid',
  upstream: {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: []},
  commands: [
    {
      id: 'help.open', label: 'Help', shortcut: 'F1', risk: 'read', undo: 'none', effect: 'view', dialog: 'dialog.help',
      description: 'Open Help: the keyboard shortcuts and the commands of the ribbon, with a search box.',
      params: s.object({search: s.optional(s.string({max: 200}))}),
      run: (ctx, p) => ({search: p.search ?? ''}),
    },
  ],
});
