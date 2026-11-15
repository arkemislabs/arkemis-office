// Combine options (submit: combine.options): a bookmark for each file, a blank page after a file with an odd number of pages, and the file size (Default or Smaller).
// Acrobat's options; printcraft has none (not checked against upstream). They are kept in the Combine files list and apply to the next Combine.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.combine-options',
  title: 'Combine options',
  command: 'combine.options',
  init(ctx) {
    const o = ctx?.view?.combine?.options ?? {};
    return {bookmarks: o.bookmarks !== false, blankAfterOdd: o.blankAfterOdd === true, size: o.size === 'smaller' ? 'smaller' : 'default'};
  },
  validate: () => [],
  toCommand: v => ({command: 'combine.options', params: {bookmarks: v.bookmarks !== false, blankAfterOdd: v.blankAfterOdd === true, size: v.size === 'smaller' ? 'smaller' : 'default'}}),
});
