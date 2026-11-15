// Empty Recycle Bin (History › Notebook Recycle Bin › Empty Recycle Bin; submit:
// history.emptyRecycleBin). OneNote asks before it permanently deletes what the bin holds.
// Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {binOf} from '../lib/pages-recycle.mjs';

export default defineDialog({
  id: 'dialog.confirm-empty-recycle-bin',
  title: 'Empty Recycle Bin',
  command: 'history.emptyRecycleBin',
  init: () => ({}),
  validate: () => [],
  preview(ctx) {
    const n = binOf(ctx.doc).length;
    return {message: `Permanently delete ${n === 1 ? 'the 1 page, section or section group' : `all ${n} pages, sections and section groups`} in the Notebook Recycle Bin? This cannot be undone from the bin.`};
  },
  toCommand: () => ({command: 'history.emptyRecycleBin', params: {confirmed: true}}),
});
