// Home > Styles > Cell Styles > Merge Styles…: the custom cell styles of another workbook that the application holds come into this one.
// Not in gridcraft (not checked against upstream): Office's behaviour. Excel lists the open workbooks; the application's windows each hold
// one workbook, so the list is the workbooks in the application's own store (open or not), asked of the main process (`host.peerStyles`),
// which hands over nothing but their custom cell styles. A style whose name is already here is kept unless `replace` is on (Excel asks
// "Merge styles that have the same name?"). Custom cell styles are not saved in .xlsx files by this application, so a workbook picked
// through the Open dialog would carry none: that way is not offered.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {hasDoc, failed, baseDoc} from '../../lib/edit-targets.mjs';

async function mergeStyles(ctx, p) {
  baseDoc(ctx);
  const peers = ctx.host?.peerStyles;
  if (!peers) throw new CommandError('unavailable', 'Other workbooks can only be read with this workbook open in a window', {hint: 'documents.open'});
  if (typeof p.from !== 'string' || !p.from) throw failed('Choose the workbook to merge styles from.');
  const theirs = await peers.get(p.from);
  if (!Array.isArray(theirs) || !theirs.length) return {added: 0, replaced: 0, skipped: 0, none: true};
  const mine = Array.isArray(ctx.doc.cellStyles) ? [...ctx.doc.cellStyles] : [];
  const at = name => mine.findIndex(x => String(x?.name ?? '').toLowerCase() === String(name).toLowerCase());
  let added = 0, replaced = 0, skipped = 0;
  for (const st of theirs) {
    if (!st || typeof st.name !== 'string' || !st.name) continue;
    const i = at(st.name);
    if (i < 0) { mine.push({...st}); added++; } else if (p.replace === true) { mine[i] = {...st}; replaced++; } else skipped++;
  }
  if (added || replaced) ctx.change.set(['cellStyles'], mine);
  return {added, replaced, skipped};
}

export default defineCommands({
  family: 'main/merge-styles',
  app: 'grid',
  upstream: {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: []},
  commands: [
    {
      id: 'home.mergeStyles', label: 'Merge Styles…', risk: 'edit', dialog: 'dialog.mergeStyles',
      description: 'Bring the custom cell styles of another workbook the application holds (`from`: its document id) into this one; styles with the same name are kept unless `replace` is true. → {added, replaced, skipped}.',
      params: s.object({from: s.optional(s.string({min: 1, max: 80})), replace: s.optional(s.boolean())}),
      state: hasDoc,
      run: mergeStyles,
    },
  ],
});
