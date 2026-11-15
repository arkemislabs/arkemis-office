// Disable History for this Notebook (History › Page Versions / Notebook Recycle Bin; submit:
// history.disable). OneNote warns that turning history off deletes every page version and the
// Recycle Bin. When history is already off the same button turns it on (no warning needed).
// Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {binOf} from '../lib/pages-recycle.mjs';

export default defineDialog({
  id: 'dialog.confirm-disable-history',
  title: 'Disable History',
  command: 'history.disable',
  init: ctx => ({enabling: ctx.doc?.notebook?.historyDisabled === true}),
  validate: () => [],
  preview(ctx, v) {
    if (v.enabling) return {message: 'Turn page history back on for this notebook? Versions are saved again from now on.'};
    const versions = Object.values(ctx.doc.versions ?? {}).reduce((n, l) => n + l.length, 0);
    return {message: `Disabling history deletes ${versions} saved page version${versions === 1 ? '' : 's'} and the ${binOf(ctx.doc).length} item${binOf(ctx.doc).length === 1 ? '' : 's'} in the Recycle Bin for this notebook. Continue?`};
  },
  toCommand: v => ({command: 'history.disable', params: v.enabling ? {value: false} : {value: true, confirmed: true}}),
});
